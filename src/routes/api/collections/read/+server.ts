import { spawn } from 'node:child_process';
import { error, json } from '@sveltejs/kit';

// flowctl collections read has no --limit; it emits all available docs then
// exits (without --follow). We spawn it directly, cap output to `limit` docs
// by killing the process once we have enough, and use --since 1d to bound scope.
const TIMEOUT_MS = 20_000;

async function readCollection(name: string, limit: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const args = ['collections', 'read', '--collection', name, '--since', '30d', '-o', 'json'];
    const child = spawn('flowctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const docs: unknown[] = [];
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(docs);
    };
    const timer = setTimeout(() => finish(new Error(`timeout: ${stderr.slice(0, 200)}`)), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          docs.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
        if (docs.length >= limit) {
          clearTimeout(timer);
          finish();
          return;
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish(new Error(`spawn: ${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export const GET = async ({ url }) => {
  const name = url.searchParams.get('name');
  const limitStr = url.searchParams.get('limit') ?? '5';
  const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 5));
  if (!name) throw error(400, 'missing name');
  try {
    const docs = await readCollection(name, limit);
    return json(docs);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), rows: [] }, { status: 502 });
  }
};
