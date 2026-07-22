import type { LogRow } from './flowctl';

const LIMITS: Record<string, number> = {
  fatal: Infinity,
  error: 500,
  warn: 200,
  info: 100,
  debug: 0
};

export function sampleLogs(rows: LogRow[]): LogRow[] {
  const counts: Record<string, number> = {};
  const kept: LogRow[] = [];
  for (const row of rows) {
    const lvl = String(row.level ?? 'info').toLowerCase();
    counts[lvl] = (counts[lvl] ?? 0) + 1;
    const cap = LIMITS[lvl] ?? 100;
    if (counts[lvl] <= cap) kept.push(row);
  }
  return kept;
}
