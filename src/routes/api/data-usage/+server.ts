import { spawn } from 'node:child_process';
import { error, json } from '@sveltejs/kit';

// -----------------------------------------------------------------------------
// /api/data-usage — reads flowctl raw stats and buckets docs/bytes into a time
// series suitable for a bar chart. Same data the Estuary dashboard graphs.
//
// Params:
//   task   — full catalog name (capture or materialization)
//   since  — humantime duration: 1h, 24h, 7d, 30d
//   bucket — 1h | 6h | 1d — bucket width for the time series
// -----------------------------------------------------------------------------

const TIMEOUT_MS = 8 * 60_000;  // 8 min — chatty CDC captures over 30d+ need it

interface Bucket {
  ts: string;
  bytes: number;
  docs: number;
  txns: number;
}

interface StatsResult {
  task: string;
  since: string;
  bucket: string;
  total: { bytes: number; docs: number; txns: number };
  byBinding: Record<string, { bytes: number; docs: number; txns: number }>;
  series: Bucket[];
  fetchedRecords: number;
}

// Longer cache TTL because raw stats aggregation is expensive.
interface CacheEntry { at: number; value: StatsResult }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60_000;  // 15 min — historical data doesn't shift fast
// In-flight dedupe: two clients hitting the same query share one flowctl run.
const inflight = new Map<string, Promise<StatsResult>>();

function bucketMs(bucket: string): number {
  if (bucket === '6h') return 6 * 3600e3;
  if (bucket === '1d') return 86400e3;
  return 3600e3; // 1h default
}

function bucketFor(tsMs: number, widthMs: number): number {
  return Math.floor(tsMs / widthMs) * widthMs;
}

// Forward-referenced in readStatsStreaming below
interface RawStatsRecord {
  ts?: string;
  capture?: Record<string, { out?: { bytesTotal?: number; docsTotal?: number } }>;
  materialize?: Record<string, { out?: { bytesTotal?: number; docsTotal?: number } }>;
}

/**
 * Bucket-as-we-parse: streams flowctl output, aggregates each record into
 * `bucketMap` + `byBinding` on the fly, and NEVER retains the raw records.
 * This keeps memory bounded — critical for chatty CDC captures where a 30d
 * window can produce 3M+ transactions (would blow V8's ~500MB string cap).
 */
async function readStatsStreaming(
  task: string,
  since: string,
  notBefore: string | undefined,
  widthMs: number
): Promise<{
  bucketMap: Map<number, Bucket>;
  byBinding: Record<string, { bytes: number; docs: number; txns: number }>;
  totBytes: number; totDocs: number; totTxns: number;
  err?: string;
}> {
  return new Promise((resolve) => {
    const args = notBefore
      ? ['raw', 'stats', '--task', task, '--not-before', notBefore, '-o', 'json']
      : ['raw', 'stats', '--task', task, '--since', since, '-o', 'json'];
    const child = spawn('flowctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const bucketMap = new Map<number, Bucket>();
    const byBinding: Record<string, { bytes: number; docs: number; txns: number }> = {};
    let totBytes = 0, totDocs = 0, totTxns = 0;
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err?: string) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ bucketMap, byBinding, totBytes, totDocs, totTxns, err });
    };
    const timer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line) as RawStatsRecord;
          const t = r.ts ? Date.parse(r.ts) : NaN;
          if (isNaN(t)) continue;
          const bucketTs = bucketFor(t, widthMs);
          const b = bucketMap.get(bucketTs) ?? { ts: new Date(bucketTs).toISOString(), bytes: 0, docs: 0, txns: 0 };
          let recBytes = 0, recDocs = 0;
          for (const kind of ['capture', 'materialize'] as const) {
            const obj = r[kind] ?? {};
            for (const [binding, stats] of Object.entries(obj)) {
              const rb = stats.out?.bytesTotal ?? 0;
              const rd = stats.out?.docsTotal ?? 0;
              recBytes += rb;
              recDocs += rd;
              const bb = byBinding[binding] ?? { bytes: 0, docs: 0, txns: 0 };
              bb.bytes += rb; bb.docs += rd; bb.txns += 1;
              byBinding[binding] = bb;
            }
          }
          b.bytes += recBytes; b.docs += recDocs; b.txns += 1;
          bucketMap.set(bucketTs, b);
          totBytes += recBytes; totDocs += recDocs; totTxns += 1;
        } catch { /* skip malformed line */ }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); finish(`spawn: ${e.message}`); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

export const GET = async ({ url, request }) => {
  const task = url.searchParams.get('task');
  const since = url.searchParams.get('since') ?? '24h';
  const notBefore = url.searchParams.get('notBefore') ?? undefined;   // RFC-3339
  // Auto-pick bucket width based on window size
  const bucket = url.searchParams.get('bucket') ?? (
    notBefore ? '1d' :
    since === '90d' || since === 'all' ? '1d' :
    since === '30d' ? '1d' :
    since === '7d' ? '6h' :
    '1h'
  );
  if (!task) throw error(400, 'missing task');

  const key = `${task}|${notBefore ?? since}|${bucket}`;
  const now = Date.now();
  // Ctrl+Shift+R / DevTools "Disable cache" sends Cache-Control: no-cache.
  // Also honour ?nocache=1 for explicit refresh from the UI.
  const noCache = request.headers.get('cache-control')?.includes('no-cache')
    || request.headers.get('pragma') === 'no-cache'
    || url.searchParams.get('nocache') === '1';
  if (!noCache) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return json({ ...hit.value, cached: true, cacheAgeMs: now - hit.at });
    const pending = inflight.get(key);
    if (pending) return json(await pending);
  }

  const widthMs = bucketMs(bucket);

  const promise = (async () => {
    const r = await readStatsStreaming(task, notBefore ? '30d' : since, notBefore, widthMs);
    if (r.err) throw new Error(r.err);
    return r;
  })();
  inflight.set(key, promise as unknown as Promise<StatsResult>);
  let aggregated;
  try {
    aggregated = await promise;
  } catch (e) {
    inflight.delete(key);
    return json({ error: e instanceof Error ? e.message : String(e), task, since, bucket }, { status: 502 });
  } finally {
    inflight.delete(key);
  }
  const { bucketMap, byBinding, totBytes, totDocs, totTxns } = aggregated;

  // Fill missing buckets with zeros so the chart renders a proper timeline
  const nowMs = Date.now();
  const parseSince = (s: string): number => {
    if (s === 'all') return 365 * 86400e3;
    const m = s.match(/^(\d+)([hdw])$/i);
    if (!m) return 24 * 3600e3;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    return unit === 'h' ? n * 3600e3 : unit === 'd' ? n * 86400e3 : n * 7 * 86400e3;
  };
  const startMs = notBefore
    ? bucketFor(Date.parse(notBefore), widthMs)
    : bucketFor(nowMs - parseSince(since), widthMs);
  const endMs = bucketFor(nowMs, widthMs);
  const series: Bucket[] = [];
  for (let ts = startMs; ts <= endMs; ts += widthMs) {
    series.push(bucketMap.get(ts) ?? { ts: new Date(ts).toISOString(), bytes: 0, docs: 0, txns: 0 });
  }

  const result: StatsResult = {
    task,
    since,
    bucket,
    total: { bytes: totBytes, docs: totDocs, txns: totTxns },
    byBinding,
    series,
    fetchedRecords: totTxns
  };
  cache.set(key, { at: now, value: result });
  return json(result);
};
