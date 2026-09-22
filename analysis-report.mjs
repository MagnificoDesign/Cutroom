// A report contains counts and source ordinals only. No names, UUIDs, pixels,
// fingerprints, file paths, raw browser errors, or media enter this structure.
export function analysisReport(clips) {
  return { version: '0.15', outcome: 'searching', sources: clips.length,
    inputSeconds: Math.round(clips.reduce((n, c) => n + c.duration, 0) * 100) / 100,
    analyzed: 0, candidates: 0, checked: 0, accepted: 0, selected: 0,
    rejected: {}, errors: [], errorCount: 0, limited: false };
}
export function rejectMatch(report, reason) {
  report.rejected[reason] = (report.rejected[reason] || 0) + 1;
}
export function reportError(report, stage, sourceNumbers, error) {
  report.errorCount++;
  const category = ['NotSupportedError', 'EncodingError', 'QuotaExceededError', 'OperationError', 'NotReadableError'].includes(error?.name) ? error.name : 'processing-error';
  if (report.errors.length < 24) report.errors.push({ stage, sources: sourceNumbers, category });
}
export class ConnectionSearchError extends Error {
  constructor(report) {
    const message = report.errorCount
      ? `Cutroom could not finish checking these clips (${report.errorCount} processing failures). Your ${report.sources} videos are still ready. See Search details.`
      : `No suitable multi-clip sequence was found after checking ${report.checked} connections. Your ${report.sources} videos are still ready. See Search details.`;
    super(message); this.name = 'ConnectionSearchError'; this.report = report;
  }
}
export function requireConnectedEdit(plan, sourceCount) {
  if (sourceCount > 1 && plan.segments.length < 2) throw new ConnectionSearchError(plan.diagnostics);
  return plan;
}
