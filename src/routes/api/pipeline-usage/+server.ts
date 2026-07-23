import { spawn } from 'node:child_process';
import { error, json } from '@sveltejs/kit';
import { flowctl } from '$lib/server/flowctl';

// -----------------------------------------------------------------------------
// /api/pipeline-usage — aggregates flowctl raw stats totals across all captures
// + materializations in a pipeline prefix. Called from the pipeline Stats tab
// as a SEPARATE fetch so it doesn't block the fast Stats card render.
//
// Params:
//   prefix — the pipeline source/collection/destination prefix (any of them)
//   since  — humantime duration (1h/24h/7d/30d)
// -----------------------------------------------------------------------------

interface CatalogListItem { catalogName: string }

async function taskUsageTotals(task: string, since: string, timeoutMs = 120_000): Promise<{ bytes: number; docs: number; records: number } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn('flowctl', ['raw', 'stats', '--task', task, '--since', since, '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, docs = 0, records = 0;
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (result: { bytes: number; docs: number; records: number } | { error: string }) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `timeout after ${timeoutMs}ms — task may be too chatty for this window` }), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          records++;
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
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); finish({ error: `spawn: ${e.message}` }); });
    child.on('close', () => { clearTimeout(timer); finish({ bytes, docs, records }); });
  });
}

// In-memory cache (60s), same as other atlas endpoints
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 60_000;

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  const since = url.searchParams.get('since') ?? '24h';
  if (!prefix) throw error(400, 'missing prefix');

  const key = `${prefix}|${since}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return json(hit.value);

  const rawSince = since === 'all' ? '30d' : since;
  const [captures, mats] = await Promise.all([
    flowctl<CatalogListItem[]>(['catalog', 'list', '--prefix', prefix, '--captures', '-o', 'json']).catch(() => []),
    flowctl<CatalogListItem[]>(['catalog', 'list', '--prefix', prefix, '--materializations', '-o', 'json']).catch(() => [])
  ]);
  const tasks = [...captures, ...mats];

  const results = await Promise.all(tasks.map((t) => taskUsageTotals(t.catalogName, rawSince)));
  const usage = {
    since,
    totalBytes: 0,
    totalDocs: 0,
    totalRecords: 0,
    byTask: {} as Record<string, { bytes: number; docs: number; records?: number; error?: string }>,
    failures: 0
  };
  tasks.forEach((t, i) => {
    const u = results[i];
    if ('error' in u) {
      usage.byTask[t.catalogName] = { bytes: 0, docs: 0, error: u.error };
      usage.failures++;
    } else {
      usage.byTask[t.catalogName] = u;
      usage.totalBytes += u.bytes;
      usage.totalDocs += u.docs;
      usage.totalRecords += u.records;
    }
  });

  cache.set(key, { at: now, value: usage });
  return json(usage);
};
