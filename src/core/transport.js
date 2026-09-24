/**
 * HTTP transport for violations.
 *
 * Design constraints that shaped this class:
 *  - Never throw into the caller. A proctoring session must survive a dead
 *    network, a 500, or a misconfigured URL.
 *  - Never lose the highest-severity evidence. Violations are queued in memory
 *    and retried with exponential backoff.
 *  - Use `navigator.sendBeacon` on page unload, because a normal `fetch` is
 *    cancelled when the document goes away — exactly when the last violation
 *    (e.g. tab-hidden) is the most interesting one.
 */
export class BackendTransport {
  constructor(options, getReport) {
    this.options = options;
    this.getReport = getReport;
    this.queue = [];
    this.flushing = false;
    this.timer = null;
    this.destroyed = false;

    if (this.options.enabled) {
      this._installUnloadHandler();
      if (this.options.batchIntervalMs > 0) {
        this.timer = setInterval(() => this.flush(), this.options.batchIntervalMs);
      }
    }
  }

  get enabled() {
    return Boolean(this.options.enabled && this.options.endpoint);
  }

  /**
   * Queue a violation. Sends immediately when batching is disabled.
   *
   * @param {object} violation
   * @param {object} [options]
   * @param {boolean} [options.terminal] the document is being torn down
   */
  send(violation, { terminal = false } = {}) {
    if (!this.enabled) return;

    /**
     * A terminal violation is raised while the document is unloading — the tab
     * is closing, or the page is navigating away. Queuing it would be pointless
     * twice over: this transport's own `pagehide` listener has already run and
     * flushed an empty queue, and the `fetch` the queue would start is cancelled
     * with the document. `sendBeacon` is the only channel that survives, so a
     * terminal violation skips the queue entirely.
     */
    if (terminal) {
      this._request([violation], { keepalive: true }).catch(() => {
        /* Nothing useful can be done while the page is unloading. */
      });
      return;
    }

    this.queue.push(violation);

    if (this.options.batchIntervalMs <= 0) {
      this.flush();
    }
  }

  /**
   * Send one periodic snapshot.
   *
   * Deliberately not queued and not retried. A snapshot is a sample, not
   * evidence: a backlog of stale frames arriving ten minutes late is worse than
   * a gap, and there is always another one coming. Failures are swallowed so a
   * dead endpoint cannot disturb the session.
   *
   * @param {object} snapshot { source, at, dataUrl, bytes, ... }
   */
  sendSnapshot(snapshot) {
    if (!this.enabled) return;

    const endpoint = this.options.snapshotEndpoint || this.options.endpoint;
    const payload = JSON.stringify({
      snapshots: [snapshot],
      sentAt: new Date().toISOString(),
    });

    this._sendOnce(payload, { keepalive: false, endpoint }).catch(() => {
      /* A dropped snapshot is not worth disturbing the session over. */
    });
  }

  /** Flush the queue to the endpoint. Safe to call concurrently. */
  async flush() {
    if (!this.enabled || this.flushing || this.queue.length === 0 || this.destroyed) {
      return;
    }

    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);

    try {
      await this._request(batch);
    } catch (err) {
      // Re-queue for a later attempt unless the host explicitly opted out.
      this.getReport(); // report is read for `includeReport`; keep the callback hot
      if (this.options.offlineQueue) {
        this.queue.unshift(...batch);
      }
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  async _request(batch, { keepalive = false } = {}) {
    const body = {
      violations: batch,
      sentAt: new Date().toISOString(),
    };
    if (this.options.includeReport) {
      body.report = this.getReport();
    }

    const payload = JSON.stringify(body);
    let attempt = 0;
    const maxAttempts = keepalive ? 1 : this.options.retries + 1;

    // Retry loop. Only network/5xx errors are retried; a 4xx means the request
    // itself is wrong and retrying would just hammer the endpoint.
    for (;;) {
      attempt += 1;
      try {
        await this._sendOnce(payload, { keepalive });
        return;
      } catch (err) {
        const retryable = err.retryable !== false;
        if (!retryable || attempt >= maxAttempts) throw err;
        await sleep(this.options.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  _sendOnce(payload, { keepalive, endpoint: overrideEndpoint }) {
    const { method, headers, timeoutMs } = this.options;
    const endpoint = overrideEndpoint || this.options.endpoint;

    // sendBeacon cannot set headers, so it is only usable for a plain POST.
    if (keepalive && method === 'POST' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      const ok = navigator.sendBeacon(endpoint, blob);
      if (!ok) {
        const err = new Error('sendBeacon rejected the payload');
        err.retryable = false;
        throw err;
      }
      return Promise.resolve();
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    return fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
      keepalive,
      signal: controller ? controller.signal : undefined,
    })
      .then((res) => {
        if (res.ok) return undefined;
        const err = new Error(`proctoring.js: upload failed with HTTP ${res.status}`);
        // 4xx is a caller bug, 5xx is the server's problem and worth retrying.
        err.retryable = res.status >= 500 || res.status === 429;
        err.status = res.status;
        throw err;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  /**
   * Flush with `keepalive`/beacon right before the page is torn down.
   * This is the only place we deliberately bypass the queue-retry machinery.
   */
  flushOnUnload() {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this._request(batch, { keepalive: true }).catch(() => {
      /* Nothing useful can be done while the page is unloading. */
    });
  }

  _installUnloadHandler() {
    if (typeof window === 'undefined') return;
    // `pagehide` fires more reliably than `beforeunload` on mobile Safari.
    this._onUnload = () => this.flushOnUnload();
    window.addEventListener('pagehide', this._onUnload);
    window.addEventListener('visibilitychange', this._onVisibility);
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    if (typeof window !== 'undefined' && this._onUnload) {
      window.removeEventListener('pagehide', this._onUnload);
      window.removeEventListener('visibilitychange', this._onVisibility);
    }
    this.queue = [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
