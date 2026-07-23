import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError } from '$lib/server/flowctl';
import { estimateCost, windowHours } from '$lib/server/pricing';
import { PIPELINES } from '$lib/pipelines';

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

    // Cost calc
    const cutoff = cutoffFromSince(since);
    const hrs = windowHours(since);
    const now = Date.now();
    const activeHoursByTask: number[] = tasks.map((t) => {
      const s = statuses.find((x) => x.name === t.catalogName);
      if (!s) return hrs;
      const first = s.firstActivityAt ? Date.parse(s.firstActivityAt) : 0;
      const last = s.lastActivityAt ? Date.parse(s.lastActivityAt) : now;
      const windowStart = cutoff === -Infinity ? 0 : cutoff;
      const activeStart = Math.max(windowStart, first);
      const activeEnd = Math.min(now, last);
      return Math.max(0, (activeEnd - activeStart) / 3600e3);
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

    return json({
      since,
      slug,
      taskCount: tasks.length,
      captureCount: captures.length,
      materializationCount: mats.length,
      taskStatuses: statuses,
      cost,
      docCounters: {
        available: false,
        note: 'Estuary docs-in/docs-out require read access to ops.<data-plane>.v1/stats — token lacks that scope.'
      },
      // Hints for the client
      hints: {
        publications: 'compute from streamed history on the pipeline page',
        logs: 'load via /api/logs on the Logs tab'
      }
    });
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
