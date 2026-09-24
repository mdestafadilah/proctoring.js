/**
 * Minimal Edge-over-CDP driver for Windows — no npm dependencies.
 *
 * VENDORED COPY. This is a pinned copy of the driver from the
 * `windows-edge-cdp-ui-verify` agent skill, kept inside the repo so the
 * browser suites run on any clone instead of only on the machine that happens
 * to have that skill installed. The skill remains the source of truth; if you
 * fix a bug here, fix it there too.
 *
 * Run with Bun. Chrome DevTools Protocol is spoken directly over a WebSocket,
 * so nothing needs to be installed (puppeteer-core may be missing and
 * `agent-browser` does not support Windows).
 *
 * Usage:
 *   import { launchEdge } from "./lib/cdp.mjs";
 *   const page = await launchEdge({ port: 9333, profileDir: `${process.env.TEMP}\\my-profile` });
 *   try {
 *     await page.goto("/login");
 *     await page.setValue('input[placeholder="mis. sari"]', "sari");
 *     await page.clickByText("Masuk");
 *     await page.waitFor("location.pathname !== '/login'", "login");
 *     await page.screenshot("D:/shots/01.png");
 *   } finally {
 *     await page.close();   // always: a leftover Edge locks its profile files
 *   }
 *
 * Key environment notes:
 * - `profileDir` MUST live outside the project directory.
 * - Proxy env vars are stripped here, otherwise localhost hits the proxy.
 * - `close()` must run even on failure.
 */
import fs from "fs";

const DEFAULT_EDGE_PATHS = [  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => Bun.sleep(ms);

export async function launchEdge({
  port = 9333,
  profileDir,
  edgePath,
  width = 1280,
  height = 900,
  startupTimeoutMs = 20000,
  extraArgs = [],
} = {}) {
  if (!profileDir) throw new Error("launchEdge: profileDir wajib diisi");

  // Jangan biarkan permintaan ke 127.0.0.1 lewat proxy lingkungan.
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";

  const devtools = `http://127.0.0.1:${port}`;

  if (await alive(devtools)) {
    throw new Error(
      `Port ${port} sudah dipakai. Tutup Edge yang tertinggal lebih dulu.`,
    );
  }

  const exe = edgePath ?? DEFAULT_EDGE_PATHS.find((path) => fs.existsSync(path));
  if (!exe) throw new Error("Edge tidak ditemukan — sebutkan path-nya lewat edgePath");

  const proc = Bun.spawn(
    [
      exe,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      `--window-size=${width},${height}`,
      // Caller-supplied flags, e.g. a fake webcam for getUserMedia tests.
      ...extraArgs,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const page = await connect({ devtools, proc, startupTimeoutMs });
  return page;
}

async function alive(devtools) {
  try {
    return (await fetch(`${devtools}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function connect({ devtools, proc, startupTimeoutMs }) {
  let target = null;
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`${devtools}/json/list`)).json();
      target = list.find((item) => item.type === "page");
    } catch {
      /* Edge belum siap */
    }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Tidak bisa menyambung ke Edge DevTools");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));

  let messageId = 0;
  const pending = new Map();
  const errors = [];
  const dialogs = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? reject(new Error(message.error.message))
        : resolve(message.result);
      return;
    }

    // Error runtime yang tidak muncul di output mana pun tetap ditangkap di sini.
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      errors.push(
        message.params.args.map((arg) => arg.value ?? arg.description).join(" "),
      );
    }
    // confirm()/alert() memblokir halaman sampai dijawab.
    if (message.method === "Page.javascriptDialogOpening") {
      dialogs.push(message.params.message);
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
  });

  function send(method, params = {}) {
    const id = ++messageId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? "evaluate gagal",
      );
    }
    return result.result.value;
  }

  await send("Page.enable");
  await send("Runtime.enable");

  /** Isi input yang dikendalikan React: setter native + event `input`. */
  const setValue = (selector, value) =>
    evaluate(`(function () {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("input tidak ditemukan: " + ${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return element.value;
    })()`);

  return {
    send,
    evaluate,
    errors,
    dialogs,
    setValue,

    /** Klik tombol pertama yang teksnya memuat `needle`. */
    clickByText: (needle) =>
      evaluate(`(function () {
        const button = [...document.querySelectorAll("button")].find((item) =>
          item.textContent.includes(${JSON.stringify(needle)}));
        if (!button) throw new Error("tombol tidak ditemukan: " + ${JSON.stringify(needle)});
        button.click();
        return true;
      })()`),

    async goto(path, { baseUrl, settleMs = 700 } = {}) {
      await send("Page.navigate", { url: `${baseUrl ?? this.baseUrl ?? ""}${path}` });
      await this.waitFor("document.readyState === 'complete'", `load ${path}`);
      await sleep(settleMs);
    },

    async waitFor(expression, label, timeoutMs = 15000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await evaluate(`Boolean(${expression})`)) return true;
        await sleep(200);
      }
      throw new Error(`Timeout menunggu: ${label}`);
    },

    /** Teks semua elemen yang cocok, baris baru diganti " | ". */
    texts: (selector) =>
      evaluate(
        `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.innerText.replace(/\\n/g, " | "))`,
      ),

    async screenshot(file) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(result.data, "base64"));
      return file;
    },

    /** WAJIB dipanggil di blok `finally`, termasuk saat pemeriksaan gagal. */
    async close() {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id: 999999, method: "Browser.close" }));
          await sleep(1200);
        }
      } catch {
        /* sudah tertutup */
      }

      try {
        proc.kill();
      } catch {
        /* sudah mati */
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await alive(devtools))) return;
        await sleep(300);
      }
    },
  };
}
