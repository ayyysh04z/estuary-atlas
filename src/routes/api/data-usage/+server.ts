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

const TIMEOUT_MS = 120_000;

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

// Simple in-memory cache — same TTL semantics as the flowctl wrapper
interface CacheEntry { at: number; value: StatsResult }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function bucketMs(bucket: string): number {
  if (bucket === '6h') return 6 * 3600e3;
  if (bucket === '1d') return 86400e3;
  return 3600e3; // 1h default
}

function bucketFor(tsMs: number, widthMs: number): number {
  return Math.floor(tsMs / widthMs) * widthMs;
}

async function readStats(task: string, since: string): Promise<{ records: unknown[]; err?: string }> {
  return new Promise((resolve) => {
    const args = ['raw', 'stats', '--task', task, '--since', since, '-o', 'json'];
    const child = spawn('flowctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const records: unknown[] = [];
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err?: string) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ records, err });
    };
    const timer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { records.push(JSON.parse(line)); } catch { /* skip */ }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); finish(`spawn: ${e.message}`); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

interface RawStatsRecord {
  ts?: string;
  capture?: Record<string, { out?: { bytesTotal?: number; docsTotal?: number } }>;
  materialize?: Record<string, { out?: { bytesTotal?: number; docsTotal?: number } }>;
}

export const GET = async ({ url }) => {
  const task = url.searchParams.get('task');
  const since = url.searchParams.get('since') ?? '24h';
  const bucket = url.searchParams.get('bucket') ?? (since === '30d' ? '1d' : since === '7d' ? '6h' : '1h');
  if (!task) throw error(400, 'missing task');

  const key = `${task}|${since}|${bucket}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return json(hit.value);

  const { records, err } = await readStats(task, since);
  if (err) return json({ error: err, task, since, bucket }, { status: 502 });

  const widthMs = bucketMs(bucket);
  const bucketMap = new Map<number, Bucket>();
  const byBinding: Record<string, { bytes: number; docs: number; txns: number }> = {};
  let totBytes = 0, totDocs = 0, totTxns = 0;

  for (const rec of records) {
    const r = rec as RawStatsRecord;
    const t = r.ts ? Date.parse(r.ts) : NaN;
    if (isNaN(t)) continue;
    const bucketTs = bucketFor(t, widthMs);
    const buckets = bucketMap.get(bucketTs) ?? { ts: new Date(bucketTs).toISOString(), bytes: 0, docs: 0, txns: 0 };
    let recBytes = 0, recDocs = 0;
    for (const kind of ['capture', 'materialize'] as const) {
      const obj = r[kind] ?? {};
      for (const [binding, stats] of Object.entries(obj)) {
        const b = stats.out?.bytesTotal ?? 0;
        const d = stats.out?.docsTotal ?? 0;
        recBytes += b;
        recDocs += d;
        const bb = byBinding[binding] ?? { bytes: 0, docs: 0, txns: 0 };
        bb.bytes += b;
        bb.docs += d;
        bb.txns += 1;
        byBinding[binding] = bb;
      }
    }
    buckets.bytes += recBytes;
    buckets.docs += recDocs;
    buckets.txns += 1;
    bucketMap.set(bucketTs, buckets);
    totBytes += recBytes;
    totDocs += recDocs;
    totTxns += 1;
  }

  // Fill missing buckets with zeros so the chart renders a proper timeline
  const nowMs = Date.now();
  const parseSince = (s: string): number => {
    const m = s.match(/^(\d+)([hdw])$/i);
    if (!m) return 24 * 3600e3;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    return unit === 'h' ? n * 3600e3 : unit === 'd' ? n * 86400e3 : n * 7 * 86400e3;
  };
  const startMs = bucketFor(nowMs - parseSince(since), widthMs);
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
    fetchedRecords: records.length
  };
  cache.set(key, { at: now, value: result });
  return json(result);
};
