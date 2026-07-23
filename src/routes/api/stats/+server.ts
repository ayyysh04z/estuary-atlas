import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type HistoryEvent, type LogRow } from '$lib/server/flowctl';
import { estimateCost, windowHours } from '$lib/server/pricing';
import { PIPELINES } from '$lib/pipelines';

// Parse an Estuary shard-status blob (from `flowctl catalog status`) into the
// fields the atlas cares about. Best-effort — the beta CLI's shape is subject
// to change.
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

// Parse a "since" window (e.g. "24h", "7d", "30d", "all") into a cutoff timestamp.
function cutoffFromSince(since: string): number {
  if (!since || since === 'all') return -Infinity;
  const m = since.match(/^(\d+)\s*([hdw])$/i);
  if (!m) return -Infinity;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 7 * 86400e3;
  return Date.now() - n * ms;
}

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  const since = url.searchParams.get('since') ?? '24h';
  if (!prefix) throw error(400, 'missing prefix');
  const cutoff = cutoffFromSince(since);

  try {
    // 1. Enumerate all catalog names under the prefix
    const items = await flowctl<{ catalogName: string; liveSpec?: { catalogType?: string } }[]>([
      'catalog', 'list', '--prefix', prefix, '-o', 'json'
    ]);
    const names = items.map((i) => i.catalogName);

    // 2. History (in parallel, in-flight-deduped by the flowctl wrapper).
    // We already load this on pipeline pages, so the response is usually cached.
    const historyLists = await Promise.all(
      names.map((n) => flowctl<HistoryEvent[]>([
        'catalog', 'history', '--name', n, '-o', 'json'
      ]).catch(() => [] as HistoryEvent[]))
    );

    // Count publications within the window (dedup by publicationId across specs)
    const seenPub = new Set<string>();
    let publicationCount = 0;
    let humanPubs = 0;
    let botPubs = 0;
    for (const events of historyLists) {
      for (const e of events) {
        const pub = (e.publication ?? {}) as Record<string, unknown>;
        const id = String(pub.publicationId ?? '');
        if (!id || seenPub.has(id)) continue;
        seenPub.add(id);
        const t = Date.parse(String(pub.publishedAt ?? ''));
        if (!isNaN(t) && t >= cutoff) {
          publicationCount++;
          const email = String(pub.userEmail ?? '');
          if (email.endsWith('@estuary.dev')) botPubs++;
          else humanPubs++;
        }
      }
    }

    // 3. Per-task status (captures + materializations only)
    const tasks = items.filter((i) => i.liveSpec?.catalogType === 'capture' || i.liveSpec?.catalogType === 'materialization');
    const statuses = (await Promise.all(tasks.map((t) => statusOf(t.catalogName)))).filter(Boolean) as TaskStatus[];

    // 4. Log rollup — pull recent errors/warns across each task in window
    const flowctlSince = since === 'all' ? '30d' : since; // flowctl requires a bound
    const logRollup = {
      errorCount: 0,
      warnCount: 0,
      fatalCount: 0,
      infoCount: 0,
      byTask: {} as Record<string, { error: number; warn: number; fatal: number; info: number }>
    };
    await Promise.all(
      tasks.map(async (t) => {
        try {
          const rows = await flowctl<LogRow[]>([
            'logs', '--task', t.catalogName, '--since', flowctlSince, '-o', 'json'
          ]);
          const per = { error: 0, warn: 0, fatal: 0, info: 0 };
          for (const r of rows) {
            const ts = Date.parse(String(r.ts ?? ''));
            if (!isNaN(ts) && ts < cutoff) continue;
            const lvl = String(r.level ?? '').toLowerCase();
            if (lvl in per) per[lvl as keyof typeof per]++;
          }
          logRollup.byTask[t.catalogName] = per;
          logRollup.errorCount += per.error;
          logRollup.warnCount += per.warn;
          logRollup.fatalCount += per.fatal;
          logRollup.infoCount += per.info;
        } catch {
          /* skip */
        }
      })
    );

    // 5. Cost estimate — need this pipeline's task count + existing tenant task count.
    // For accurate tier-splitting we sum tasks across ALL pipelines defined in
    // src/lib/pipelines.ts. Approximation: only count captures + materializations
    // in the same tenant prefix (ZoopOne/…).
    // Match the pipeline slug from the prefix.
    const pipeline = PIPELINES.find(
      (p) => p.prefixes.source === prefix || p.prefixes.collection === prefix || p.prefixes.destination === prefix
    );
    const slug = pipeline?.slug ?? '(unknown)';
    const hrs = windowHours(since);
    // Task count for THIS pipeline
    const taskCount = tasks.length;
    // Rough count of tasks across the tenant that come BEFORE this pipeline
    // (used for tier-splitting). Best-effort — treat every earlier pipeline
    // in PIPELINES order as already accounted for.
    let priorTasks = 0;
    for (const p of PIPELINES) {
      if (p.slug === slug) break;
      // We can't afford to hit flowctl for every pipeline's list here, so we
      // approximate: assume each pipeline runs 1 capture + 1 materialization.
      priorTasks += 2;
    }
    const currency = url.searchParams.get('currency') ?? 'USD';
    const cost = estimateCost(taskCount, priorTasks, hrs, slug, since, currency);

    return json({
      since,
      cutoffTs: cutoff === -Infinity ? null : new Date(cutoff).toISOString(),
      slug,
      specs: names.length,
      taskCount,
      publicationsInWindow: publicationCount,
      humanPublications: humanPubs,
      botPublications: botPubs,
      taskStatuses: statuses,
      logs: logRollup,
      cost,
      docCounts: {
        note: 'Estuary doc-in/doc-out counters live in ops.*/stats — this token has no access. Ask a tenant admin to grant read on ops.<data-plane>.v1/stats or the tenant-scoped ops.ZoopOne stream to unlock.'
      }
    });
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
