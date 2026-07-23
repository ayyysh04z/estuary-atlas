import { spawn } from 'node:child_process';
import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError } from '$lib/server/flowctl';
import { estimateCost, windowHours } from '$lib/server/pricing';
import { PIPELINES } from '$lib/pipelines';

// Sum docs/bytes across a task's raw stats stream — same source as
// /api/data-usage but returns just the totals (no time bucketing) so the
// pipeline Stats tab can aggregate quickly across tasks.
async function taskUsageTotals(task: string, since: string): Promise<{ bytes: number; docs: number } | null> {
  return new Promise((resolve) => {
    const child = spawn('flowctl', ['raw', 'stats', '--task', task, '--since', since, '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, docs = 0;
    let buf = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(null); }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          for (const kind of ['capture', 'materialize'] as const) {
            const obj = (r[kind] as Record<string, { out?: { bytesTotal?: number; docsTotal?: number } }>) ?? {};
            for (const b of Object.values(obj)) {
              bytes += b.out?.bytesTotal ?? 0;
              docs += b.out?.docsTotal ?? 0;
            }
          }
        } catch { /* skip */ }
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve({ bytes, docs }); });
  });
}

// -----------------------------------------------------------------------------
// /api/stats — LEAN implementation. Only flowctl calls we need:
//   1. catalog list --prefix <> --captures        (fast: 1 call)
//   2. catalog list --prefix <> --materializations (fast: 1 call)
//   3. catalog status <task> for each task        (fast: ~200ms each, ≤3 tasks typical)
//
// We DELIBERATELY do NOT fetch:
//   - flowctl catalog history — the pipeline page already streams historyByName;
//     the client can compute publication counts from that.
//   - flowctl logs — a 7d/30d log pull is 20-30s per task and dominates latency.
//     The Logs tab already fetches its own data.
//
// Result: this endpoint returns in under 1s for a typical pipeline.
// -----------------------------------------------------------------------------

interface TaskStatus {
  name: string;
  ok: boolean;
  summary: string;
  lastActivityAt?: string;
  firstActivityAt?: string;
  shardCount?: number;
  recentFailureCount?: number;
}

async function statusOf(name: string): Promise<TaskStatus | null> {
  try {
    const raw = await flowctl<unknown[]>(['catalog', 'status', name, '-o', 'json']);
    const rec = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : (raw as Record<string, unknown>);
    if (!rec) return null;
    const s = (rec.status as Record<string, unknown>) ?? {};
    const controller = (s.controller as Record<string, unknown>) ?? {};
    const activation = (controller.activation as Record<string, unknown>) ?? {};
    const shard = (activation.shardStatus as Record<string, unknown>) ?? {};
    return {
      name: String(rec.catalogName ?? name),
      ok: String(s.type ?? '') === 'OK',
      summary: String(s.summary ?? ''),
      lastActivityAt: (shard.lastTs as string) ?? undefined,
      firstActivityAt: (shard.firstTs as string) ?? undefined,
      shardCount: (shard.count as number) ?? undefined,
      recentFailureCount: (activation.recentFailureCount as number) ?? 0
    };
  } catch {
    return null;
  }
}

function cutoffFromSince(since: string): number {
  if (!since || since === 'all') return -Infinity;
  const m = since.match(/^(\d+)\s*([hdw])$/i);
  if (!m) return -Infinity;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 7 * 86400e3;
  return Date.now() - n * ms;
}

interface CatalogListItem {
  catalogName: string;
  liveSpec?: { catalogType?: string };
}

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  const since = url.searchParams.get('since') ?? '24h';
  const currency = url.searchParams.get('currency') ?? 'USD';
  if (!prefix) throw error(400, 'missing prefix');

  try {
    // Two parallel list calls — captures and materializations only.
    // Collections are excluded because they don't incur task-hour cost.
    const [captures, mats] = await Promise.all([
      flowctl<CatalogListItem[]>(['catalog', 'list', '--prefix', prefix, '--captures', '-o', 'json']).catch(() => []),
      flowctl<CatalogListItem[]>(['catalog', 'list', '--prefix', prefix, '--materializations', '-o', 'json']).catch(() => [])
    ]);
    const tasks = [...captures, ...mats];

    // Fetch shard status for each task (parallel, in-flight-deduped by flowctl wrapper).
    const statuses = (await Promise.all(tasks.map((t) => statusOf(t.catalogName)))).filter(Boolean) as TaskStatus[];

    // Cost calc.  NOTE: for since='all', cutoffFromSince returns -Infinity
    // which used to let activeStart snap to epoch (1970) when a task lacks
    // firstActivityAt, producing 495,788 "active hours" and ₹30 lakh nonsense.
    // Bound the window to hrs and clamp per-task active hours to the same.
    const rawCutoff = cutoffFromSince(since);
    const hrs = windowHours(since);
    const now = Date.now();
    const effectiveCutoff = rawCutoff === -Infinity ? now - hrs * 3600e3 : rawCutoff;
    const activeHoursByTask: number[] = tasks.map((t) => {
      const s = statuses.find((x) => x.name === t.catalogName);
      if (!s) return hrs;
      const first = s.firstActivityAt ? Date.parse(s.firstActivityAt) : 0;
      const last = s.lastActivityAt ? Date.parse(s.lastActivityAt) : now;
      const activeStart = Math.max(effectiveCutoff, first);
      const activeEnd = Math.min(now, last);
      const rawHours = Math.max(0, (activeEnd - activeStart) / 3600e3);
      // Belt + suspenders: never exceed the window itself.
      return Math.min(hrs, rawHours);
    });

    const pipeline = PIPELINES.find(
      (p) => p.prefixes.source === prefix || p.prefixes.collection === prefix || p.prefixes.destination === prefix
    );
    const slug = pipeline?.slug ?? '(unknown)';
    // Approximate prior-tenant task count for tier splitting: 2 per earlier pipeline.
    let priorTasks = 0;
    for (const p of PIPELINES) {
      if (p.slug === slug) break;
      priorTasks += 2;
    }

    const cost = estimateCost(activeHoursByTask, priorTasks, hrs, slug, since, currency);

    // Data-volume aggregation removed from this endpoint — raw stats for chatty
    // pipelines (prod-stack, meta) can take >60s per task, blowing our budget.
    // Client fetches /api/pipeline-usage separately with a loading state.
    void taskUsageTotals;  // keep import used for now

    return json({
      since,
      slug,
      taskCount: tasks.length,
      captureCount: captures.length,
      materializationCount: mats.length,
      taskStatuses: statuses,
      cost,
      docCounters: {
        available: true,
        note: 'Doc + volume totals from flowctl raw stats. Per-task breakdown available under each capture/materialization → Data tab.'
      }
    });
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
