import { spawn } from 'node:child_process';

const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 45_000;
const CONCURRENCY = 4;
const DANGEROUS = ['publish', 'delete', 'apply', 'deploy', '--push'];

interface CacheEntry {
  at: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();
// In-flight dedupe: identical concurrent calls share the same promise.
const inflight = new Map<string, Promise<unknown>>();

// Global concurrency limiter (max CONCURRENCY parallel flowctl child processes).
let running = 0;
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
  return new Promise((resolve) => {
    if (running < CONCURRENCY) {
      running++;
      resolve();
    } else {
      queue.push(() => {
        running++;
        resolve();
      });
    }
  });
}
function release(): void {
  running--;
  const next = queue.shift();
  if (next) next();
}

export interface CatalogListItem {
  catalogName: string;
  type?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface HistoryEvent {
  publicationId?: string;
  pubId?: string;
  builtAt?: string;
  builtStartedAt?: string;
  publishedAt?: string;
  detail?: string;
  userEmail?: string;
  user?: string;
  publication?: { model?: Record<string, unknown>; detail?: string; [k: string]: unknown };
  spec?: Record<string, unknown>;
  catalogName?: string;
  [k: string]: unknown;
}

export interface LogRow {
  ts?: string;
  time?: string;
  level?: string;
  message?: string;
  fields?: Record<string, unknown>;
  task?: string;
  [k: string]: unknown;
}

export class FlowctlError extends Error {
  constructor(message: string, public code: number | null, public stderr: string) {
    super(message);
    this.name = 'FlowctlError';
  }
}

function assertSafe(args: string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    for (const bad of DANGEROUS) {
      if (lower.includes(bad)) {
        throw new Error(`Refused: flowctl arg contains dangerous token "${bad}": ${arg}`);
      }
    }
  }
}

async function runFlowctl(args: string[]): Promise<string> {
  await acquire();
  return new Promise((resolve, reject) => {
    const child = spawn('flowctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const releaseOnce = (() => { let done = false; return () => { if (!done) { done = true; release(); } }; })();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      releaseOnce();
      reject(new FlowctlError(`flowctl timed out after ${TIMEOUT_MS}ms`, null, stderr));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      releaseOnce();
      reject(new FlowctlError(`flowctl spawn error: ${err.message}`, null, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      releaseOnce();
      if (code !== 0) {
        reject(new FlowctlError(`flowctl exited ${code}`, code, stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseOutput(raw: string, opts?: { expectArray?: boolean }): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return opts?.expectArray === false ? null : [];
  // JSONL first: multiple lines each parseable as JSON
  const lines = trimmed.split('\n').filter((l) => l.trim());
  if (lines.length > 1) {
    const out: unknown[] = [];
    let allParsed = true;
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { allParsed = false; break; }
    }
    if (allParsed) return out;
  }
  // Single line — try as JSON. If flowctl's `catalog list -o json` returns one
  // object per line, a single-item result is one object; wrap to array for
  // list-shaped commands (default). For single-object endpoints, opt out.
  try {
    const parsed = JSON.parse(trimmed);
    if (opts?.expectArray === false) return parsed;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return opts?.expectArray === false ? null : [];
  }
}

export async function flowctl<T = unknown>(
  args: string[],
  opts?: { noCache?: boolean; expectArray?: boolean }
): Promise<T> {
  assertSafe(args);
  const key = args.join('\x00');
  const now = Date.now();
  if (!opts?.noCache) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return hit.value as T;
    }
    // In-flight dedupe: identical concurrent calls await the same promise
    // instead of spawning parallel flowctl processes.
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const promise = (async () => {
    try {
      const raw = await runFlowctl(args);
      const value = parseOutput(raw, { expectArray: opts?.expectArray });
      cache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise as Promise<T>;
}

export function clearCache(): void {
  cache.clear();
}
