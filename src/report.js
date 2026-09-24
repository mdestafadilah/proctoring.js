import { SEVERITY, severityWeight } from './core/options.js';

/**
 * Report formatting helpers.
 *
 * Kept out of the store so the wire format can evolve independently of how
 * violations are captured. Nothing here mutates the session.
 */

/**
 * Render a report as a compact plain-text summary, suitable for pasting into a
 * support ticket or printing alongside an exam result.
 *
 * @param {object} report output of `proctor.getReport()`
 * @returns {string}
 */
export function formatReport(report) {
  if (!report) return 'proctoring.js: no report';

  const lines = [];
  lines.push('Proctoring report');
  lines.push('=================');
  lines.push(`Session      : ${report.sessionId ?? '(none)'}`);
  lines.push(`Started      : ${report.startedAt ?? '-'}`);
  lines.push(`Ended        : ${report.endedAt ?? '-'}`);
  lines.push(`Duration     : ${formatDuration(report.durationMs)}`);
  lines.push(`Score        : ${report.score ?? 100}/100`);
  lines.push(`Worst        : ${report.worstSeverity ?? 'none'}`);
  lines.push(`Violations   : ${report.total}`);
  if (report.droppedCount) {
    lines.push(`Dropped      : ${report.droppedCount} (report cap reached)`);
  }

  const counts = Object.entries(report.countsByType || {});
  if (counts.length > 0) {
    lines.push('');
    lines.push('Breakdown');
    lines.push('---------');
    for (const [type, count] of counts.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(4)}  ${type}`);
    }
  }

  if (report.violations?.length) {
    lines.push('');
    lines.push('Timeline');
    lines.push('--------');
    for (const v of report.violations) {
      const at = new Date(v.timestamp).toISOString().slice(11, 19);
      const offset = `+${formatDuration(v.elapsedMs)}`;
      lines.push(`  ${at} ${offset} [${v.severity}] ${v.type}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a report into CSV.
 *
 * One row per violation so it can be opened directly in a spreadsheet — which
 * is how most invigilators will actually consume this data.
 */
export function reportToCsv(report) {
  const header = ['id', 'type', 'severity', 'detector', 'timestamp', 'elapsedMs', 'details'];
  const rows = (report?.violations || []).map((v) => [
    v.id,
    v.type,
    v.severity,
    v.detector ?? '',
    new Date(v.timestamp).toISOString(),
    v.elapsedMs,
    JSON.stringify(v.details ?? {}),
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Download the report as a JSON file from the browser. */
export function downloadReport(report, filename = 'proctoring-report.json') {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

/** Download the report as CSV from the browser. */
export function downloadReportCsv(report, filename = 'proctoring-report.csv') {
  const blob = new Blob([reportToCsv(report)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, filename);
}

/**
 * Merge several per-session reports into one, e.g. for a whole class.
 * Violations keep their original timestamps; the merged report spans the
 * earliest start to the latest end.
 */
export function mergeReports(reports) {
  const list = (reports || []).filter(Boolean);
  if (list.length === 0) {
    return {
      sessionId: null,
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      total: 0,
      countsByType: {},
      violations: [],
      sessions: 0,
    };
  }

  const startTimes = list.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);
  const endTimes = list.map((r) => Date.parse(r.endedAt)).filter(Number.isFinite);

  const violations = list
    .flatMap((r) => r.violations || [])
    .sort((a, b) => a.timestamp - b.timestamp);

  const countsByType = {};
  for (const v of violations) {
    countsByType[v.type] = (countsByType[v.type] || 0) + 1;
  }

  const startedAt = startTimes.length ? Math.min(...startTimes) : null;
  const endedAt = endTimes.length ? Math.max(...endTimes) : null;

  return {
    sessionId: list.length === 1 ? list[0].sessionId : `merged_${list.length}`,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    endedAt: endedAt ? new Date(endedAt).toISOString() : null,
    durationMs: startedAt && endedAt ? endedAt - startedAt : 0,
    total: violations.length,
    countsByType,
    violations,
    sessions: list.length,
  };
}

/** Compare two reports, useful for re-checking the same candidate. */
export function diffReports(before, after) {
  const seen = new Set((before?.violations || []).map((v) => v.id));
  const added = (after?.violations || []).filter((v) => !seen.has(v.id));
  return {
    added,
    addedCount: added.length,
    beforeTotal: before?.total ?? 0,
    afterTotal: after?.total ?? 0,
  };
}

/** Highest severity present, or 'none'. */
export function worstSeverityOf(violations) {
  let worst = null;
  for (const v of violations || []) {
    if (worst === null || severityWeight(v.severity) > severityWeight(worst)) {
      worst = v.severity;
    }
  }
  return worst ?? 'none';
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function csvCell(value) {
  const str = value == null ? '' : String(value);
  // Quote any cell containing a delimiter, quote, or newline, per RFC 4180.
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export { SEVERITY };
