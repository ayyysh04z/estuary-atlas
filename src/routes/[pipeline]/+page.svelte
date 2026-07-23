<script lang="ts">
  import type { PageProps } from './$types';
  import Chips from '$lib/components/Chips.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import BarChart from '$lib/components/BarChart.svelte';
  import MultiBarChart from '$lib/components/MultiBarChart.svelte';
  import { captureChips, collectionChips, materializationChips, extractSpecBody } from '$lib/chips';
  import type { HistoryEvent, LogRow } from '$lib/server/flowctl';

  let { data }: PageProps = $props();

  // Streamed history+models — data.streamed is an unresolved promise.
  // We track resolution locally so templates can show skeletons until ready.
  let streamed = $state<{
    history: HistoryEvent[];
    historyByName: Record<string, HistoryEvent[]>;
    ready: boolean;
  }>({ history: [], historyByName: {}, ready: false });

  $effect(() => {
    // Reset on navigation between pipelines.
    streamed = { history: [], historyByName: {}, ready: false };
    let cancelled = false;
    data.streamed?.then((r) => {
      if (cancelled) return;
      streamed = { ...r, ready: true };
    });
    return () => { cancelled = true; };
  });

  let tab = $state<'overview' | 'collections' | 'bindings' | 'history' | 'logs' | 'stats'>('overview');

  // ─── Stats tab ────────────────────────────────────────────────────────────
  interface StatsPayload {
    since: string;
    slug: string;
    taskCount: number;
    captureCount: number;
    materializationCount: number;
    taskStatuses: Array<{ name: string; ok: boolean; summary: string; lastActivityAt?: string; firstActivityAt?: string; recentFailureCount?: number }>;
    cost: { total: number; taskHourCost: number; dataVolumeCost: number | null; byocMonthlyCost: number | null; currency: string; symbol: string; fxRate: number; perTierExplanation: string; disclaimers: string[]; windowHours: number };
    docCounters: { available: boolean; note: string };
  }
  interface UsagePayload {
    since: string;
    totalBytes: number;
    totalDocs: number;
    totalRecords: number;
    byTask: Record<string, { bytes: number; docs: number; records?: number; error?: string }>;
    failures: number;
  }

  function fmtBytes(v: number): string {
    if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
    return `${v.toFixed(0)} B`;
  }
  function fmtDocs(v: number): string {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return v.toLocaleString();
  }
  let stats = $state<StatsPayload | null>(null);
  let statsLoading = $state(false);
  let statsError = $state<string | null>(null);
  const STATS_RANGES = [
    { label: '1h', value: '1h' },
    { label: '24h', value: '24h' },
    { label: '3d', value: '3d' },
    { label: '7d', value: '7d' },
    { label: '30d', value: '30d' },
    { label: 'all', value: 'all' }
  ];
  let statsSince = $state('24h');
  let statsCurrency = $state<'USD' | 'INR'>('USD');

  // Pipeline data-volume aggregation (separate fetch — flowctl raw stats can
  // be slow for chatty prod-stack captures, so we don't block the main Stats card).
  let usage = $state<UsagePayload | null>(null);
  let usageLoading = $state(false);
  let usageError = $state<string | null>(null);

  // Pipeline TIMELINE — per-task /api/data-usage results merged into
  // source-lane + destination-lane bucketed series. Progressive: each task
  // resolves independently and the merged series updates reactively.
  interface UsageBucket { ts: string; bytes: number; docs: number; txns: number }
  interface TaskUsage { series: UsageBucket[]; total: { bytes: number; docs: number; txns: number } }
  let timelineTasks = $state<Record<string, TaskUsage | { error: string } | 'loading'>>({});
  let timelineMetric = $state<'bytes' | 'docs'>('bytes');
  let timelineSince = $derived(statsSince === 'all' ? '30d' : statsSince);

  // When statsSince changes OR tab activated, spawn one fetch per task in parallel.
  $effect(() => {
    if (tab !== 'stats') return;
    const _dep = statsSince;
    const tasks = [
      ...data.captures.map((c) => ({ name: c.catalogName, kind: 'source' as const })),
      ...data.materializations.map((m) => ({ name: m.catalogName, kind: 'dest' as const }))
    ];
    // Reset and mark all as loading
    const initial: Record<string, TaskUsage | { error: string } | 'loading'> = {};
    for (const t of tasks) initial[t.name] = 'loading';
    timelineTasks = initial;
    const acs = tasks.map(() => new AbortController());
    tasks.forEach((t, i) => {
      fetch(`/api/data-usage?task=${encodeURIComponent(t.name)}&since=${timelineSince}`, { signal: acs[i].signal })
        .then((r) => (r.ok ? r.json() : r.text().then((tx) => Promise.reject(tx))))
        .then((res: TaskUsage) => { timelineTasks = { ...timelineTasks, [t.name]: res }; })
        .catch((err) => {
          if (acs[i].signal.aborted) return;
          timelineTasks = { ...timelineTasks, [t.name]: { error: String(err) } };
        });
    });
    return () => acs.forEach((a) => a.abort());
  });

  // Merged source + destination series aligned to the union of all task buckets.
  const timelineSeries = $derived.by(() => {
    const captureNames = new Set(data.captures.map((c) => c.catalogName));
    const bucketMap = new Map<string, { ts: string; sourceBytes: number; sourceDocs: number; destBytes: number; destDocs: number }>();
    for (const [name, tu] of Object.entries(timelineTasks)) {
      if (tu === 'loading' || 'error' in tu) continue;
      const isSource = captureNames.has(name);
      for (const b of tu.series) {
        const key = b.ts;
        const row = bucketMap.get(key) ?? { ts: key, sourceBytes: 0, sourceDocs: 0, destBytes: 0, destDocs: 0 };
        if (isSource) { row.sourceBytes += b.bytes; row.sourceDocs += b.docs; }
        else          { row.destBytes += b.bytes; row.destDocs += b.docs; }
        bucketMap.set(key, row);
      }
    }
    return [...bucketMap.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  });

  const timelineProgress = $derived.by(() => {
    const total = Object.keys(timelineTasks).length;
    const done = Object.values(timelineTasks).filter((v) => v !== 'loading').length;
    const errors = Object.values(timelineTasks).filter((v) => typeof v === 'object' && v !== null && 'error' in v).length;
    return { total, done, errors, pending: total - done };
  });

  // Combined series for the MultiBarChart — one row per bucket with
  // metric-appropriate keys already resolved.
  const combinedSeries = $derived(
    timelineSeries.map((b) => ({
      ts: b.ts,
      source: timelineMetric === 'bytes' ? b.sourceBytes : b.sourceDocs,
      dest: timelineMetric === 'bytes' ? b.destBytes : b.destDocs
    }))
  );

  $effect(() => {
    if (tab !== 'stats') return;
    const _dep = statsSince;
    const ac = new AbortController();
    usage = null;
    usageLoading = true;
    usageError = null;
    fetch(
      `/api/pipeline-usage?prefix=${encodeURIComponent(data.pipeline.prefixes.source)}&since=${statsSince}`,
      { signal: ac.signal }
    )
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(t))))
      .then((res: UsagePayload) => { usage = res; usageLoading = false; })
      .catch((err) => {
        if (ac.signal.aborted) return;
        usageError = String(err);
        usageLoading = false;
      });
    return () => ac.abort();
  });

  // Publications in stats window — computed CLIENT-side from streamed data
  // (no extra flowctl calls on the server). Recomputes when since / stream change.
  const statsPubCounts = $derived.by(() => {
    const cutoff = (() => {
      if (statsSince === 'all') return -Infinity;
      const m = statsSince.match(/^(\d+)([hdw])$/i);
      if (!m) return -Infinity;
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const ms = unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 7 * 86400e3;
      return Date.now() - n * ms;
    })();
    const seen = new Set<string>();
    let total = 0, human = 0, bot = 0;
    for (const events of Object.values(streamed.historyByName)) {
      for (const e of events ?? []) {
        const pub = (e.publication ?? {}) as Record<string, unknown>;
        const id = String(pub.publicationId ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const t = Date.parse(String(pub.publishedAt ?? ''));
        if (isNaN(t) || t < cutoff) continue;
        total++;
        const email = String(pub.userEmail ?? '');
        if (email.endsWith('@estuary.dev')) bot++; else human++;
      }
    }
    return { total, human, bot };
  });

  $effect(() => {
    if (tab !== 'stats') return;
    const _dep1 = statsSince; const _dep2 = statsCurrency;
    const ac = new AbortController();
    statsLoading = true;
    statsError = null;
    fetch(
      `/api/stats?prefix=${encodeURIComponent(data.pipeline.prefixes.source)}&since=${statsSince}&currency=${statsCurrency}`,
      { signal: ac.signal }
    )
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(t))))
      .then((res: StatsPayload) => { stats = res; statsLoading = false; })
      .catch((err) => {
        if (ac.signal.aborted) return;
        statsError = String(err);
        statsLoading = false;
      });
    return () => ac.abort();
  });

  interface EnrichedSpec {
    name: string;
    kind: 'capture' | 'collection' | 'materialization';
    chips: ReturnType<typeof captureChips>;
    body: Record<string, unknown> | null;
  }

  function enrich(
    items: { catalogName: string }[],
    kind: 'capture' | 'collection' | 'materialization'
  ): EnrichedSpec[] {
    return items.map((item) => {
      const events = streamed.historyByName[item.catalogName] ?? [];
      const latest = events[0];
      const model = latest?.publication?.model as Record<string, unknown> | undefined;
      const catType = String((latest as Record<string, unknown> | undefined)?.catalog_type ?? '');
      const extracted = extractSpecBody(model, item.catalogName, catType);
      const body = extracted?.body ?? null;
      let chips: ReturnType<typeof captureChips> = [];
      if (body) {
        if (kind === 'capture') chips = captureChips(body);
        else if (kind === 'collection') chips = collectionChips(body);
        else chips = materializationChips(body);
      }
      return { name: item.catalogName, kind, chips, body };
    });
  }

  const capturesEnriched = $derived(enrich(data.captures, 'capture'));
  const collectionsEnriched = $derived(enrich(data.collections, 'collection'));
  const matsEnriched = $derived(enrich(data.materializations, 'materialization'));

  function fmtTs(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.publishedAt ?? e.builtAt ?? e.publishedAt ?? e.builtStartedAt ?? '');
  }
  function fmtUser(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.userEmail ?? e.userEmail ?? e.user ?? '—');
  }
  function fmtUserFull(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    const full = p.userFullName;
    return full ? String(full) : '';
  }
  function fmtDetail(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.detail ?? e.detail ?? '');
  }
  function pubId(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.publicationId ?? e.publicationId ?? e.pubId ?? '');
  }
  function isBot(user: string): boolean {
    return user.includes('support@estuary.dev') || user.includes('inference');
  }

  // History grouping: publicationId -> {rep event, affected specs}
  interface PubGroup {
    id: string;
    rep: HistoryEvent;
    specs: string[];
  }
  const grouped = $derived.by<PubGroup[]>(() => {
    const map = new Map<string, PubGroup>();
    for (const [name, events] of Object.entries(streamed.historyByName)) {
      for (const e of events ?? []) {
        const id = pubId(e);
        if (!id) continue;
        const g = map.get(id);
        if (g) {
          if (!g.specs.includes(name)) g.specs.push(name);
        } else {
          map.set(id, { id, rep: e, specs: [name] });
        }
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => fmtTs(b.rep).localeCompare(fmtTs(a.rep)));
    return arr;
  });

  let showHumans = $state(true);
  let showBots = $state(false);

  const filteredGroups = $derived(
    grouped.filter((g) => {
      const bot = isBot(fmtUser(g.rep));
      return bot ? showBots : showHumans;
    })
  );

  // Logs tab
  const allTasks = $derived([
    ...data.captures.map((c) => c.catalogName),
    ...data.materializations.map((m) => m.catalogName)
  ]);
  let selectedTask = $state<string>('');
  let logRows = $state<LogRow[]>([]);
  let logsLoading = $state(false);
  let logsError = $state<string | null>(null);
  let lvlFatal = $state(true);
  let lvlError = $state(true);
  let lvlWarn = $state(true);
  let lvlInfo = $state(false);
  let logSearch = $state('');
  const LOG_RANGES = [
    { label: '1h', value: '1h' },
    { label: '24h', value: '24h' },
    { label: '3d', value: '3d' },
    { label: '7d', value: '7d' },
    { label: '30d', value: '30d' }
  ];
  let logSince = $state('24h');

  $effect(() => {
    if (tab !== 'logs' || !selectedTask) return;
    // AbortController cancels an in-flight fetch when tab/task/since changes or
    // user leaves the page — server-side flowctl process disconnects (its
    // output just stops being read).
    const _dep = logSince; // read for reactivity
    const ac = new AbortController();
    logsLoading = true;
    logsError = null;
    fetch(`/api/logs?task=${encodeURIComponent(selectedTask)}&since=${logSince}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(t))))
      .then((rows: LogRow[]) => {
        logRows = rows;
        logsLoading = false;
      })
      .catch((err) => {
        if (ac.signal.aborted) return; // silent cancel
        logsError = String(err);
        logRows = [];
        logsLoading = false;
      });
    return () => ac.abort();
  });

  const lvlCounts = $derived.by(() => {
    const c: Record<string, number> = { fatal: 0, error: 0, warn: 0, info: 0 };
    for (const r of logRows) {
      const l = String(r.level ?? 'info').toLowerCase();
      if (l in c) c[l]++;
    }
    return c;
  });

  const filteredLogs = $derived(
    logRows.filter((r) => {
      const lvl = String(r.level ?? 'info').toLowerCase();
      const okLvl =
        (lvl === 'fatal' && lvlFatal) ||
        (lvl === 'error' && lvlError) ||
        (lvl === 'warn' && lvlWarn) ||
        (lvl === 'info' && lvlInfo);
      if (!okLvl) return false;
      if (logSearch && !String(r.message ?? '').toLowerCase().includes(logSearch.toLowerCase()))
        return false;
      return true;
    })
  );

  function fmtLogTs(r: LogRow): string {
    const ts = String(r.ts ?? r.time ?? '');
    // extract HH:MM:SS if ISO
    const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : ts.slice(0, 8);
  }

  const topCollections = $derived(collectionsEnriched.slice(0, 6));
  const extraCollections = $derived(Math.max(0, collectionsEnriched.length - 6));
</script>

<div class="pagehead">
  <h1>{data.pipeline.slug}</h1>
  <span class="breadcrumb mono">
    {data.pipeline.prefixes.source} → {data.pipeline.prefixes.collection} → {data.pipeline.prefixes.destination}
  </span>
</div>

<div class="tabs">
  <button class:active={tab === 'overview'} onclick={() => (tab = 'overview')}>Overview</button>
  <button class:active={tab === 'collections'} onclick={() => (tab = 'collections')}>
    Collections · {collectionsEnriched.length}
  </button>
  <button class:active={tab === 'bindings'} onclick={() => (tab = 'bindings')}>Bindings</button>
  <button class:active={tab === 'history'} onclick={() => (tab = 'history')}>
    History · {streamed.ready ? grouped.length : '…'}
  </button>
  <button class:active={tab === 'logs'} onclick={() => (tab = 'logs')}>Logs</button>
  <button class:active={tab === 'stats'} onclick={() => (tab = 'stats')}>Stats</button>
  {#if !streamed.ready}
    <span class="tab-loading">
      <span class="pulse-dot"></span>
      loading models…
    </span>
  {/if}
</div>

{#if tab === 'overview'}
  <div class="lanes">
    <div class="lane">
      <div class="lane-head">
        <span class="lane-title">Sources</span>
        <span class="lane-count">{capturesEnriched.length}</span>
      </div>
      {#each capturesEnriched as spec}
        <div class="lane-item">
          <a href="/{data.pipeline.slug}/{encodeURIComponent(spec.name)}">{spec.name}</a>
          <div style="margin-top:3px"><Chips chips={spec.chips} /></div>
        </div>
      {/each}
      {#if capturesEnriched.length === 0}
        <div class="muted small">none</div>
      {/if}
    </div>
    <div class="lane-sep">→</div>
    <div class="lane">
      <div class="lane-head">
        <span class="lane-title">Collections</span>
        <span class="lane-count">{collectionsEnriched.length}</span>
      </div>
      {#each topCollections as spec}
        <div class="lane-item">
          <a href="/{data.pipeline.slug}/{encodeURIComponent(spec.name)}">{spec.name}</a>
          <div style="margin-top:3px"><Chips chips={spec.chips} /></div>
        </div>
      {/each}
      {#if extraCollections > 0}
        <div class="muted small">+ {extraCollections} more (see Collections tab)</div>
      {/if}
      {#if collectionsEnriched.length === 0}
        <div class="muted small">none</div>
      {/if}
    </div>
    <div class="lane-sep">→</div>
    <div class="lane">
      <div class="lane-head">
        <span class="lane-title">Destinations</span>
        <span class="lane-count">{matsEnriched.length}</span>
      </div>
      {#each matsEnriched as spec}
        <div class="lane-item">
          <a href="/{data.pipeline.slug}/{encodeURIComponent(spec.name)}">{spec.name}</a>
          <div style="margin-top:3px"><Chips chips={spec.chips} /></div>
        </div>
      {/each}
      {#if matsEnriched.length === 0}
        <div class="muted small">none</div>
      {/if}
    </div>
  </div>

{:else if tab === 'collections'}
  <table>
    <thead>
      <tr>
        <th>Collection</th>
        <th>Key</th>
        <th>Chips</th>
      </tr>
    </thead>
    <tbody>
      {#each collectionsEnriched as spec}
        <tr>
          <td><a href="/{data.pipeline.slug}/{encodeURIComponent(spec.name)}">{spec.name}</a></td>
          <td class="dim">
            {#if spec.body?.key}
              {(spec.body.key as string[]).join(', ')}
            {:else}
              —
            {/if}
          </td>
          <td><Chips chips={spec.chips} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else if tab === 'bindings'}
  <div class="stack gap-lg">
    {#each [...capturesEnriched, ...matsEnriched] as spec}
      <section>
        <h4 class="muted small">{spec.kind}: {spec.name}</h4>
        {#if spec.body?.bindings}
          {@const bindings = spec.body.bindings as Record<string, unknown>[]}
          <table>
            <thead>
              <tr>
                <th>Source / Target</th>
                <th>Resource</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {#each bindings as b}
                <tr>
                  <td>{String(b.target ?? b.source ?? '')}</td>
                  <td class="dim mono">
                    {#if b.resource}
                      {JSON.stringify(b.resource)}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td class="dim">
                    {(b.resource as Record<string, unknown> | undefined)?.delta_updates ? 'yes' : 'no'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="muted small">No model available (no history events yet).</p>
        {/if}
      </section>
    {/each}
  </div>
{:else if tab === 'history'}
  <div class="hint mb-lg">
    <strong>How to read this:</strong> Each row is one <code>flowctl publish</code> event.
    Rows by <code>support@estuary.dev</code> are Estuary's auto-inference bot updating readSchemas as it
    observes data — not deliberate changes.
  </div>
  <div class="filter-bar">
    <label><input type="checkbox" bind:checked={showHumans} /> humans <b>{grouped.filter(g => !isBot(fmtUser(g.rep))).length}</b></label>
    <label><input type="checkbox" bind:checked={showBots} /> bots <b>{grouped.filter(g => isBot(fmtUser(g.rep))).length}</b></label>
    <span class="muted small" style="margin-left:auto">{filteredGroups.length} of {grouped.length} publications</span>
  </div>
  {#if !streamed.ready}
    <Skeleton rows={5} height="52px" />
  {:else if filteredGroups.length === 0}
    <p class="muted">no history matches filter</p>
  {/if}
  {#each filteredGroups as g}
    <details class="pub-group">
      <summary>
        <span class="dim">{fmtTs(g.rep)}</span>
        <span style="color:var(--accent)">{g.id.slice(0, 12)}</span>
        <span class="dim">{fmtUser(g.rep)}</span>
        <span>{fmtDetail(g.rep)}</span>
        <span class="muted">{g.specs.length} spec{g.specs.length === 1 ? '' : 's'}</span>
      </summary>
      <ul>
        {#each g.specs as s}
          <li><a href="/{data.pipeline.slug}/{encodeURIComponent(s)}">{s}</a></li>
        {/each}
      </ul>
    </details>
  {/each}
{:else if tab === 'logs'}
  <div class="logs-controls">
    <label>
      task:
      <select bind:value={selectedTask}>
        <option value="">— select —</option>
        {#each data.captures as c}
          <option value={c.catalogName}>[capture] {c.catalogName}</option>
        {/each}
        {#each data.materializations as m}
          <option value={m.catalogName}>[materialization] {m.catalogName}</option>
        {/each}
      </select>
    </label>
    <div class="range-pills">
      <span class="range-lbl">since:</span>
      {#each LOG_RANGES as r}
        <button
          type="button"
          class="range-pill"
          class:on={logSince === r.value}
          onclick={() => (logSince = r.value)}
        >{r.label}</button>
      {/each}
    </div>
    <label><input type="checkbox" bind:checked={lvlFatal} /> <span class="chip log-fatal">fatal</span> <b>{lvlCounts.fatal}</b></label>
    <label><input type="checkbox" bind:checked={lvlError} /> <span class="chip log-error">error</span> <b>{lvlCounts.error}</b></label>
    <label><input type="checkbox" bind:checked={lvlWarn} /> <span class="chip log-warn">warn</span> <b>{lvlCounts.warn}</b></label>
    <label><input type="checkbox" bind:checked={lvlInfo} /> <span class="chip log-info">info</span> <b>{lvlCounts.info}</b></label>
    <label style="flex:1">
      search:
      <input type="search" bind:value={logSearch} placeholder="message contains…" style="width:100%" />
    </label>
  </div>
  {#if !selectedTask}
    <p class="muted small">No logs pulled yet — logs will load automatically when you pick a task.</p>
  {:else if logsLoading}
    <p class="muted small">loading logs…</p>
  {:else if logsError}
    <div class="error-box">{logsError}</div>
  {:else if filteredLogs.length === 0}
    <p class="muted small">no matching log rows ({logRows.length} total pulled)</p>
  {:else}
    <div class="log-rows">
      {#each filteredLogs as r}
        <div class="log-row">
          <span class="ts">{fmtLogTs(r)}</span>
          <span class="lvl {String(r.level ?? 'info').toLowerCase()}">{r.level ?? 'info'}</span>
          <span>{r.message ?? ''}</span>
        </div>
      {/each}
    </div>
  {/if}
{:else if tab === 'stats'}
  <div class="filter-bar">
    <div class="range-pills">
      <span class="range-lbl">since:</span>
      {#each STATS_RANGES as r}
        <button
          type="button"
          class="range-pill"
          class:on={statsSince === r.value}
          onclick={() => (statsSince = r.value)}
        >{r.label}</button>
      {/each}
    </div>
    <div class="range-pills">
      <span class="range-lbl">currency:</span>
      <button
        type="button"
        class="range-pill"
        class:on={statsCurrency === 'USD'}
        onclick={() => (statsCurrency = 'USD')}
      >USD $</button>
      <button
        type="button"
        class="range-pill"
        class:on={statsCurrency === 'INR'}
        onclick={() => (statsCurrency = 'INR')}
      >INR ₹</button>
    </div>
    <span class="muted small" style="margin-left:auto">
      {#if statsLoading}loading…{:else if stats}{stats.taskCount} tasks · {stats.specs} specs{/if}
    </span>
  </div>

  {#if statsLoading && !stats}
    <Skeleton rows={6} height="60px" />
  {:else if statsError}
    <div class="error-box">{statsError}</div>
  {:else if stats}
    {#if usageLoading}
      <div class="hint" style="margin-bottom:16px">
        <strong>Volume + docs are streaming in.</strong> The atlas is running
        <code>flowctl raw stats</code> for every task and summing per-transaction
        counters. On CDC-heavy pipelines (like <code>prod-stack</code>) this can take
        <strong>2–8 minutes cold</strong>. Subsequent loads within 15 minutes are cached and instant.
      </div>
    {/if}
    <div class="stats-grid">
      <div class="stat-card cost">
        <div class="sc-label">Estimated cost · {stats.cost.windowHours}h window</div>
        <div class="sc-value">{stats.cost.symbol}{stats.cost.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sc-sub">{stats.cost.perTierExplanation}</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Task-hour cost</div>
        <div class="sc-value sub">{stats.cost.symbol}{stats.cost.taskHourCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sc-sub">{stats.taskCount} tasks × {stats.cost.windowHours} hours</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Data volume cost</div>
        <div class="sc-value sub">
          {#if stats.cost.dataVolumeCost != null}
            {stats.cost.symbol}{stats.cost.dataVolumeCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          {:else}
            <span class="dim">n/a</span>
          {/if}
        </div>
        <div class="sc-sub">
          {#if stats.cost.dataVolumeCost == null}
            set <code>gb_per_month</code> in <code>data/pricing.yaml</code>
          {:else}
            estimated from override
          {/if}
        </div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Publications</div>
        <div class="sc-value sub">{streamed.ready ? statsPubCounts.total : '…'}</div>
        <div class="sc-sub">
          {#if streamed.ready}
            {statsPubCounts.human} human · {statsPubCounts.bot} bot
          {:else}
            <span class="dim">loading history…</span>
          {/if}
        </div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Logs</div>
        <div class="sc-value sub"><a href="#" onclick={(e) => { e.preventDefault(); tab = 'logs'; }}>open Logs tab</a></div>
        <div class="sc-sub">per-task levels + search available there</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Data pushed IN by sources</div>
        <div class="sc-value sub">
          {#if usageLoading}<span class="dim" style="font-size:14px">loading…</span>
          {:else if usage}
            {@const inBytes = Object.entries(usage.byTask).filter(([n]) => data.captures.some(c => c.catalogName === n)).reduce((s, [, u]) => s + u.bytes, 0)}
            {fmtBytes(inBytes)}
          {:else if usageError}<span class="dim" style="font-size:12px">error</span>
          {:else}<span class="dim">—</span>{/if}
        </div>
        <div class="sc-sub">
          <span class="legend-dot" style="background:#7fbfff"></span> written to Flow{#if usage && 'cached' in usage && (usage as {cached?: boolean}).cached} · <span style="color:var(--accent)">cached</span>{/if}
        </div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Data read OUT by destinations</div>
        <div class="sc-value sub">
          {#if usageLoading}<span class="dim" style="font-size:14px">loading…</span>
          {:else if usage}
            {@const outBytes = Object.entries(usage.byTask).filter(([n]) => data.materializations.some(m => m.catalogName === n)).reduce((s, [, u]) => s + u.bytes, 0)}
            {fmtBytes(outBytes)}
          {:else}<span class="dim">—</span>{/if}
        </div>
        <div class="sc-sub">
          <span class="legend-dot" style="background:#ffb547"></span> read from Flow · {stats.taskCount} tasks
        </div>
      </div>
    </div>

    <!-- ─── Timeline chart ─────────────────────────────────────────────── -->
    <h4 class="section-h" style="margin-top:24px">
      Timeline · sources vs destinations
      <span class="tl-progress muted small" style="font-weight:normal">
        {#if timelineProgress.pending > 0}
          · loading {timelineProgress.done}/{timelineProgress.total} tasks…
        {:else}
          · {timelineProgress.done}/{timelineProgress.total} tasks{#if timelineProgress.errors > 0} · <span style="color:var(--danger)">{timelineProgress.errors} failed</span>{/if}
        {/if}
      </span>
    </h4>
    <div class="timeline-controls">
      <div class="range-pills">
        <span class="range-lbl">metric:</span>
        <button
          type="button" class="range-pill"
          class:on={timelineMetric === 'bytes'}
          onclick={() => (timelineMetric = 'bytes')}
        >Data</button>
        <button
          type="button" class="range-pill"
          class:on={timelineMetric === 'docs'}
          onclick={() => (timelineMetric = 'docs')}
        >Docs</button>
      </div>
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:#7fbfff"></span> Sources (data in)</span>
        <span><span class="legend-dot" style="background:#ffb547"></span> Destinations (data out)</span>
      </div>
    </div>

    {#if timelineSeries.length === 0 && timelineProgress.pending > 0}
      <Skeleton rows={3} height="60px" />
    {:else if timelineSeries.length > 0}
      <div class="chart-header">
        <span class="legend-dot" style="background:#7fbfff"></span>
        <span class="chart-title">Sources vs Destinations</span>
        <span class="chart-help muted small">
          · thin blue bar = data IN (captures write) · thin amber bar = data OUT (mats read) · hover any bar for exact values
        </span>
      </div>
      <MultiBarChart
        data={combinedSeries}
        series={[
          { key: 'source', label: 'Sources · data in',  color: '#7fbfff' },
          { key: 'dest',   label: 'Destinations · out', color: '#ffb547' }
        ]}
        format={timelineMetric === 'bytes' ? fmtBytes : fmtDocs}
      />
    {/if}
    <!-- ─── /Timeline ──────────────────────────────────────────────────── -->

    {#if usage && Object.keys(usage.byTask).length > 0}
      {@const captureNames = new Set(data.captures.map(c => c.catalogName))}
      {@const sourceEntries = Object.entries(usage.byTask).filter(([n]) => captureNames.has(n)).sort((a, b) => b[1].bytes - a[1].bytes)}
      {@const destEntries = Object.entries(usage.byTask).filter(([n]) => !captureNames.has(n)).sort((a, b) => b[1].bytes - a[1].bytes)}
      {@const totalIn = sourceEntries.reduce((s, [, u]) => s + u.bytes, 0)}
      {@const totalOut = destEntries.reduce((s, [, u]) => s + u.bytes, 0)}

      <h4 class="section-h">
        <span class="legend-dot" style="background:#7fbfff"></span>
        Sources — data written INTO Flow · {fmtBytes(totalIn)}
      </h4>
      {#if sourceEntries.length === 0}
        <p class="muted small">no capture tasks</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Capture</th>
              <th style="text-align:right">Data in</th>
              <th style="text-align:right">Docs in</th>
              <th style="text-align:right"></th>
            </tr>
          </thead>
          <tbody>
            {#each sourceEntries as [name, u]}
              <tr>
                <td class="mono-cell" style="font-size:11px">{name}</td>
                <td class="dim mono-cell" style="text-align:right">
                  {#if u.error}<span style="color:var(--danger)">{u.error.slice(0, 40)}</span>{:else}{fmtBytes(u.bytes)}{/if}
                </td>
                <td class="dim mono-cell" style="text-align:right">{u.error ? '—' : fmtDocs(u.docs)}</td>
                <td class="dim mono-cell" style="text-align:right">
                  <a href="/{data.pipeline.slug}/{encodeURIComponent(name)}">Data tab →</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <h4 class="section-h" style="margin-top:20px">
        <span class="legend-dot" style="background:#ffb547"></span>
        Destinations — data read FROM Flow · {fmtBytes(totalOut)}
      </h4>
      {#if destEntries.length === 0}
        <p class="muted small">no materialization tasks</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Materialization</th>
              <th style="text-align:right">Data out</th>
              <th style="text-align:right">Docs out</th>
              <th style="text-align:right"></th>
            </tr>
          </thead>
          <tbody>
            {#each destEntries as [name, u]}
              <tr>
                <td class="mono-cell" style="font-size:11px">{name}</td>
                <td class="dim mono-cell" style="text-align:right">
                  {#if u.error}<span style="color:var(--danger)">{u.error.slice(0, 40)}</span>{:else}{fmtBytes(u.bytes)}{/if}
                </td>
                <td class="dim mono-cell" style="text-align:right">{u.error ? '—' : fmtDocs(u.docs)}</td>
                <td class="dim mono-cell" style="text-align:right">
                  <a href="/{data.pipeline.slug}/{encodeURIComponent(name)}">Data tab →</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
    {#if usageError}
      <div class="error-box mt-lg">Pipeline usage error: {usageError}</div>
    {/if}

    <h4 class="section-h">Task status</h4>
    {#if stats.taskStatuses.length === 0}
      <p class="muted small">no task statuses returned</p>
    {:else}
      <table>
        <thead>
          <tr><th>Task</th><th>Status</th><th>Last activity</th><th>Recent failures</th></tr>
        </thead>
        <tbody>
          {#each stats.taskStatuses as t}
            <tr>
              <td class="mono-cell">{t.name}</td>
              <td>
                <span class="chip {t.ok ? 'default' : 'danger'}" style="font-size:9.5px">
                  {t.summary || (t.ok ? 'OK' : 'ERROR')}
                </span>
              </td>
              <td class="dim">{t.lastActivityAt ? new Date(t.lastActivityAt).toISOString().slice(0, 19) : '—'}</td>
              <td class="dim">{t.recentFailureCount ?? 0}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <h4 class="section-h">Notes</h4>
    <ul class="dim small notes">
      {#each stats.cost.disclaimers as d}
        <li>{d}</li>
      {/each}
      <li>{stats.docCounters.note}</li>
      <li>For full breakdown per binding + graph over time, open a capture or materialization → <strong>Data</strong> tab.</li>
    </ul>
  {/if}
{/if}

<style>
  .tab-loading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 6px 12px;
    color: var(--accent);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-family: var(--font-mono);
  }
  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse-dot 1.1s ease-in-out infinite;
    display: inline-block;
  }
  @keyframes pulse-dot {
    0%, 100% { transform: scale(0.6); opacity: 0.4; }
    50% { transform: scale(1); opacity: 1; }
  }
  .range-pills {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px 2px 0;
    border-right: 1px solid var(--line);
    margin-right: 4px;
  }
  .range-lbl {
    color: var(--text-dim);
    font-size: 11px;
    margin-right: 4px;
    letter-spacing: 0.06em;
  }
  .range-pill {
    background: transparent;
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 10px;
    cursor: pointer;
    border-radius: 3px;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1.4;
  }
  .range-pill:hover { color: var(--text); border-color: var(--text-mute); background: transparent; }
  .range-pill.on {
    background: rgba(208, 255, 63, 0.08);
    color: var(--accent);
    border-color: var(--accent);
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 16px 18px;
    min-height: 100px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stat-card.cost {
    border-color: var(--accent);
    background: rgba(208, 255, 63, 0.04);
  }
  .stat-card .sc-label {
    color: var(--text-dim);
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .stat-card .sc-value {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 26px;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.01em;
  }
  .stat-card.cost .sc-value { color: var(--accent); font-size: 30px; }
  .stat-card .sc-value.sub { font-size: 22px; }
  .stat-card .sc-value .dim { color: var(--text-mute); font-size: 14px; font-weight: 500; }
  .stat-card .sc-sub {
    color: var(--text-mute);
    font-size: 10.5px;
    line-height: 1.5;
    margin-top: auto;
    font-family: var(--font-mono);
  }
  .stat-card .sc-sub code {
    background: var(--bg-3);
    border: 1px solid var(--line);
    padding: 1px 5px;
    font-size: 10px;
    color: var(--accent);
    border-radius: 2px;
  }
  .section-h {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    margin: 24px 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  ul.notes { margin: 0; padding-left: 20px; line-height: 1.6; }
  ul.notes li { margin-bottom: 6px; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .tl-progress { margin-left: 8px; }
  .timeline-controls {
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
    padding: 12px 16px; margin-bottom: 12px;
    background: var(--bg-2); border: 1px solid var(--line); border-radius: 4px;
  }
  .chart-legend { display: flex; gap: 16px; color: var(--text-dim); font-size: 11.5px; margin-left: auto; }
  .chart-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px 8px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 4px 4px 0 0;
  }
  .chart-title { color: var(--text); font-family: var(--font-mono); font-size: 12px; font-weight: 500; }
  .chart-help { margin-left: auto; text-align: right; }
</style>
