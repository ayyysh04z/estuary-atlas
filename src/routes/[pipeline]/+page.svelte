<script lang="ts">
  import type { PageProps } from './$types';
  import Chips from '$lib/components/Chips.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
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

  let tab = $state<'overview' | 'collections' | 'bindings' | 'history' | 'logs'>('overview');

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
</style>
