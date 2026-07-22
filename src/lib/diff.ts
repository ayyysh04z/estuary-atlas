import diff from 'microdiff';

export interface DiffEntry {
  path: (string | number)[];
  type: 'CREATE' | 'REMOVE' | 'CHANGE';
  oldValue?: unknown;
  value?: unknown;
}

export function diffModels(
  a: Record<string, unknown> | undefined | null,
  b: Record<string, unknown> | undefined | null
): DiffEntry[] {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  const raw = diff(left, right, { cyclesFix: true });
  return raw.map((d) => ({
    path: d.path,
    type: d.type,
    oldValue: 'oldValue' in d ? (d as { oldValue?: unknown }).oldValue : undefined,
    value: 'value' in d ? (d as { value?: unknown }).value : undefined
  }));
}

export function groupByTopLevel(entries: DiffEntry[]): Record<string, DiffEntry[]> {
  const out: Record<string, DiffEntry[]> = {};
  for (const e of entries) {
    const key = String(e.path[0] ?? '(root)');
    (out[key] ||= []).push(e);
  }
  return out;
}

export function formatPath(path: (string | number)[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('.');
}
