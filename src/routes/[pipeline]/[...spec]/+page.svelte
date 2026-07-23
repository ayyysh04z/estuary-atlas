<script lang="ts">
  import type { PageProps } from './$types';
  import JsonView from '$lib/components/JsonView.svelte';
  import SchemaView from '$lib/components/SchemaView.svelte';
  import BindingsTable from '$lib/components/BindingsTable.svelte';
  import KeyValue from '$lib/components/KeyValue.svelte';
  import BarChart from '$lib/components/BarChart.svelte';
  import { extractSpecBody } from '$lib/chips';
  import { diffModels, groupByTopLevel, formatPath, type DiffEntry } from '$lib/diff';
  import { flattenSchema } from '$lib/schema';
  import type { HistoryEvent } from '$lib/server/flowctl';

  let { data }: PageProps = $props();

  let tab = $state<'model' | 'history' | 'diff' | 'schema' | 'sample' | 'data'>('model');

  function pubId(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.publicationId ?? e.publicationId ?? e.pubId ?? '');
  }
  function fmtTs(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.publishedAt ?? e.builtAt ?? e.publishedAt ?? e.builtStartedAt ?? '');
  }
  function fmtUser(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.userEmail ?? e.userEmail ?? '—');
  }
  function fmtDetail(e: HistoryEvent): string {
    const p = (e.publication ?? {}) as Record<string, unknown>;
    return String(p.detail ?? e.detail ?? '');
  }
  function modelOf(e: HistoryEvent | undefined): { kind: 'capture' | 'collection' | 'materialization'; body: Record<string, unknown> } | null {
    if (!e) return null;
    return extractSpecBody(
      e.publication?.model as Record<string, unknown> | undefined,
      data.specName,
      String((e as Record<string, unknown>).catalog_type ?? (e as Record<string, unknown>).catalogType ?? '')
    );
  }

  const latest = $derived(data.events[0]);
  const latestExtract = $derived(modelOf(latest));
  const latestBody = $derived(latestExtract?.body ?? null);
  const specKind = $derived(latestExtract?.kind ?? null);

  // Diff picker state
  let leftId = $state<string>('');
  let rightId = $state<string>('');

  $effect(() => {
    if (data.events.length >= 2 && !leftId && !rightId) {
      rightId = pubId(data.events[0]);
      leftId = pubId(data.events[1]);
    }
  });

  const leftEvent = $derived(data.events.find((e) => pubId(e) === leftId));
  const rightEvent = $derived(data.events.find((e) => pubId(e) === rightId));

  const diffEntries = $derived.by<DiffEntry[]>(() => {
    if (!leftEvent || !rightEvent) return [];
    const l = modelOf(leftEvent)?.body ?? null;
    const r = modelOf(rightEvent)?.body ?? null;
    return diffModels(l ?? {}, r ?? {});
  });
  const grouped = $derived(groupByTopLevel(diffEntries));

  function short(v: unknown): string {
    if (v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  // Schema rows (collections only)
  const schemaRows = $derived.by(() => {
    if (specKind !== 'collection' || !latestBody) return [];
    const schema = latestBody['readSchema'] ?? latestBody['writeSchema'];
    return flattenSchema(schema, 4);
  });

  // Per-event change summary: diff this event's model against the *previous* (older) publication.
  // Events are sorted newest-first, so the "previous" is events[i+1].
  interface EventChange {
    total: number;
    creates: number;
    removes: number;
    changes: number;
    entries: DiffEntry[];
  }
  function changesFor(idx: number): EventChange {
    const cur = modelOf(data.events[idx])?.body ?? null;
    const prev = modelOf(data.events[idx + 1])?.body ?? null;
    if (!prev) {
      // This is the first (oldest) publish — treat everything as new.
      return { total: 0, creates: 0, removes: 0, changes: 0, entries: [] };
    }
    if (!cur) return { total: 0, creates: 0, removes: 0, changes: 0, entries: [] };
    const entries = diffModels(prev, cur);
    let c = 0, r = 0, ch = 0;
    for (const e of entries) {
      if (e.type === 'CREATE') c++;
      else if (e.type === 'REMOVE') r++;
      else ch++;
    }
    return { total: entries.length, creates: c, removes: r, changes: ch, entries };
  }

  // History filters (spec detail)
  let showHumans = $state(true);
  let showBots = $state(true);
  const HIST_RANGES = [
    { label: '24h', ms: 24 * 3600e3 },
    { label: '3d', ms: 3 * 24 * 3600e3 },
    { label: '7d', ms: 7 * 24 * 3600e3 },
    { label: '30d', ms: 30 * 24 * 3600e3 },
    { label: 'all', ms: Infinity }
  ];
  let histRange = $state('all');
  const filteredEvents = $derived.by(() => {
    const range = HIST_RANGES.find((r) => r.label === histRange) ?? HIST_RANGES[HIST_RANGES.length - 1];
    const cutoff = range.ms === Infinity ? -Infinity : Date.now() - range.ms;
    return data.events.filter((e) => {
      const u = fmtUser(e);
      const bot = u.endsWith('@estuary.dev');
      if (bot && !showBots) return false;
      if (!bot && !showHumans) return false;
      const ts = fmtTs(e);
      const when = ts ? Date.parse(ts) : NaN;
      if (!isNaN(when) && when < cutoff) return false;
      return true;
    });
  });
  const humanCount = $derived(data.events.filter((e) => !fmtUser(e).endsWith('@estuary.dev')).length);
  const botCount = $derived(data.events.filter((e) => fmtUser(e).endsWith('@estuary.dev')).length);

  // ─── Data-usage tab (Estuary raw stats) ───────────────────────────────────
  interface UsageBucket { ts: string; bytes: number; docs: number; txns: number }
  interface UsagePayload {
    task: string;
    since: string;
    bucket: string;
    total: { bytes: number; docs: number; txns: number };
    byBinding: Record<string, { bytes: number; docs: number; txns: number }>;
    series: UsageBucket[];
    fetchedRecords: number;
  }
  let usage = $state<UsagePayload | null>(null);
  let usageLoading = $state(false);
  let usageError = $state<string | null>(null);
  let usageSince = $state('7d');
  let usageMetric = $state<'bytes' | 'docs'>('bytes');
  let usageCustom = $state(false);
  // Default: from = 90 days ago, to = today (only used when usageCustom = true)
  let usageFrom = $state(new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10));
  let usageTo = $state(new Date().toISOString().slice(0, 10));
  const USAGE_RANGES = [
    { label: '24h', value: '24h' },
    { label: '7d', value: '7d' },
    { label: '30d', value: '30d' },
    { label: '90d', value: '90d' },
    { label: 'all', value: 'all' }
  ];

  $effect(() => {
    if (tab !== 'data') return;
    if (specKind !== 'capture' && specKind !== 'materialization') return;
    const _dep = usageSince; const _dep2 = usageCustom; const _dep3 = usageFrom; const _dep4 = usageTo;
    const ac = new AbortController();
    usageLoading = true;
    usageError = null;
    const params = usageCustom
      ? `task=${encodeURIComponent(data.specName)}&notBefore=${encodeURIComponent(new Date(usageFrom + 'T00:00:00Z').toISOString())}`
      : `task=${encodeURIComponent(data.specName)}&since=${usageSince}`;
    fetch(`/api/data-usage?${params}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(t))))
      .then((res: UsagePayload) => {
        usage = res;
        usageLoading = false;
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        usageError = String(err);
        usageLoading = false;
      });
    return () => ac.abort();
  });

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

  // Sample docs — default to 1 (fast); user can bump the limit to pull more.
  let sampleDocs = $state<unknown[]>([]);
  let sampleLoading = $state(false);
  let sampleError = $state<string | null>(null);
  let sampleLimit = $state(1);
  let sampleFetchToken = $state(0); // increment to force refetch
  const SAMPLE_LIMITS = [1, 5, 10, 25];

  $effect(() => {
    if (tab !== 'sample' || specKind !== 'collection') return;
    const _dep = sampleLimit; const _dep2 = sampleFetchToken; // reactivity
    const ac = new AbortController();
    sampleLoading = true;
    sampleError = null;
    fetch(
      `/api/collections/read?name=${encodeURIComponent(data.specName)}&limit=${sampleLimit}`,
      { signal: ac.signal }
    )
      .then((r) => r.json())
      .then((res) => {
        if (Array.isArray(res)) sampleDocs = res;
        else if (res.error) { sampleError = res.error; sampleDocs = []; }
        sampleLoading = false;
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        sampleError = String(err);
        sampleLoading = false;
      });
    return () => ac.abort();
  });
</script>

<div class="pagehead">
  <h1 class="mono" style="font-size:14px">{data.specName}</h1>
  {#if specKind}
    <span class="chip default">{specKind}</span>
  {/if}
</div>
<div class="breadcrumb mono">
  <a href="/{data.pipeline.slug}">← {data.pipeline.slug}</a>
</div>

{#if data.error}
  <div class="error-box mt-lg">flowctl error: {data.error}</div>
{/if}

<div class="tabs">
  <button class:active={tab === 'model'} onclick={() => (tab = 'model')}>Model</button>
  <button class:active={tab === 'history'} onclick={() => (tab = 'history')}>
    History · {data.events.length}
  </button>
  <button class:active={tab === 'diff'} onclick={() => (tab = 'diff')}>Diff</button>
  {#if specKind === 'collection'}
    <button class:active={tab === 'schema'} onclick={() => (tab = 'schema')}>
      Schema · {schemaRows.length}
    </button>
    <button class:active={tab === 'sample'} onclick={() => (tab = 'sample')}>Sample</button>
  {/if}
  {#if specKind === 'capture' || specKind === 'materialization'}
    <button class:active={tab === 'data'} onclick={() => (tab = 'data')}>Data</button>
  {/if}
</div>

{#if tab === 'model'}
  {#if latestBody}
    <div class="stack gap-lg">
      {#if 'key' in latestBody && Array.isArray(latestBody.key)}
        <section>
          <h4 class="section-title">Key</h4>
          <div class="chips">
            {#each latestBody.key as k}
              <span class="chip info">{String(k)}</span>
            {/each}
          </div>
        </section>
      {/if}

      {#if specKind === 'collection'}
        {#if 'readSchema' in latestBody}
          <section>
            <h4 class="section-title">Read Schema <span class="section-sub">(downstream contract)</span></h4>
            <SchemaView schema={latestBody.readSchema} />
          </section>
        {/if}
        {#if 'writeSchema' in latestBody}
          <section>
            <h4 class="section-title">Write Schema <span class="section-sub">(what capture writes)</span></h4>
            <SchemaView schema={latestBody.writeSchema} />
          </section>
        {/if}
      {:else if specKind === 'capture' || specKind === 'materialization'}
        {#if latestBody.endpoint}
          <section>
            <h4 class="section-title">Endpoint</h4>
            <KeyValue data={latestBody.endpoint} />
          </section>
        {/if}
        {#if latestBody.autoDiscover}
          <section>
            <h4 class="section-title">Auto Discover</h4>
            <KeyValue data={latestBody.autoDiscover} />
          </section>
        {/if}
        {#if latestBody.shards}
          <section>
            <h4 class="section-title">Shards</h4>
            <KeyValue data={latestBody.shards} />
          </section>
        {/if}
        {#if Array.isArray(latestBody.bindings)}
          <section>
            <h4 class="section-title">Bindings <span class="section-sub">· {(latestBody.bindings as unknown[]).length}</span></h4>
            <BindingsTable bindings={latestBody.bindings} kind={specKind} />
          </section>
        {/if}
        {#if latestBody.source && specKind === 'materialization'}
          <section>
            <h4 class="section-title">Source</h4>
            <KeyValue data={latestBody.source} />
          </section>
        {/if}
      {/if}

      <details class="raw-model">
        <summary>Raw model JSON</summary>
        <JsonView value={latestBody} />
      </details>
    </div>
  {:else}
    <p class="muted">No model available in the latest history event.</p>
  {/if}
{:else if tab === 'history'}
  {#if data.events.length === 0}
    <p class="muted">no history events</p>
  {:else}
    <div class="hist-controls">
      <div class="range-pills">
        <span class="range-lbl">since:</span>
        {#each HIST_RANGES as r}
          <button
            type="button"
            class="range-pill"
            class:on={histRange === r.label}
            onclick={() => (histRange = r.label)}
          >{r.label}</button>
        {/each}
      </div>
      <label><input type="checkbox" bind:checked={showHumans} /> humans <b>{humanCount}</b></label>
      <label><input type="checkbox" bind:checked={showBots} /> bots <b>{botCount}</b></label>
      <span class="muted small" style="margin-left:auto">
        {filteredEvents.length} of {data.events.length}
      </span>
    </div>
    {#if filteredEvents.length === 0}
      <p class="muted small">no history events match filter</p>
    {/if}
    <div class="pub-timeline">
      {#each filteredEvents as e, i}
        {@const user = fmtUser(e)}
        {@const bot = user.includes('@estuary.dev')}
        {@const ts = fmtTs(e)}
        {@const originalIdx = data.events.indexOf(e)}
        {@const ch = changesFor(originalIdx)}
        {@const isFirst = originalIdx === data.events.length - 1}
        <details class="pub-group" class:bot class:human={!bot} open={!bot && i < 3}>
          <summary>
            <span class="pub-date">
              {ts.slice(0,10)}
              <span class="pub-time">{ts.slice(11,19)}</span>
            </span>
            <span class="pub-id">{pubId(e).slice(-8)}</span>
            <span class="pub-user">
              {#if bot}<span class="chip default" style="font-size:9px">bot</span>{:else}<span class="chip modified" style="font-size:9px">human</span>{/if}
              <b>{user}</b>
            </span>
            <span class="pub-changes">
              {#if isFirst}
                <span class="chip info" style="font-size:9px">initial publish</span>
              {:else if ch.total === 0}
                <span class="chip default" style="font-size:9px">no model change</span>
              {:else}
                {#if ch.creates}<span class="chip modified" style="font-size:9px">+{ch.creates}</span>{/if}
                {#if ch.removes}<span class="chip danger" style="font-size:9px">−{ch.removes}</span>{/if}
                {#if ch.changes}<span class="chip warm" style="font-size:9px">~{ch.changes}</span>{/if}
              {/if}
            </span>
          </summary>
          {#if fmtDetail(e)}
            <div class="pub-detail">{fmtDetail(e)}</div>
          {/if}
          {#if ch.entries.length > 0}
            <div class="pub-changes-list">
              <h5>What changed from prior publication</h5>
              <div class="diff">
                {#each ch.entries.slice(0, 40) as d}
                  <div class="diff-row {d.type}">
                    <span class="diff-path">{formatPath(d.path)}</span>
                    {#if d.type === 'CREATE'}
                      + {short(d.value)}
                    {:else if d.type === 'REMOVE'}
                      − {short(d.oldValue)}
                    {:else}
                      {short(d.oldValue)} → {short(d.value)}
                    {/if}
                  </div>
                {/each}
                {#if ch.entries.length > 40}
                  <div class="diff-row" style="color:var(--text-mute);border:none;background:none">
                    … {ch.entries.length - 40} more changes
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </details>
      {/each}
    </div>
  {/if}
{:else if tab === 'diff'}
  {#if data.events.length < 2}
    <p class="muted">Need at least 2 publications to diff.</p>
  {:else}
    <div class="row gap-lg" style="margin-bottom:12px">
      <label class="small">
        old
        <select bind:value={leftId} class="mono">
          {#each data.events as e}
            <option value={pubId(e)}>{pubId(e).slice(0, 12)} · {fmtTs(e)}</option>
          {/each}
        </select>
      </label>
      <span class="muted">→</span>
      <label class="small">
        new
        <select bind:value={rightId} class="mono">
          {#each data.events as e}
            <option value={pubId(e)}>{pubId(e).slice(0, 12)} · {fmtTs(e)}</option>
          {/each}
        </select>
      </label>
      <span class="muted small">{diffEntries.length} changes</span>
    </div>

    {#if diffEntries.length === 0}
      <p class="muted">No differences.</p>
    {:else}
      <div class="diff stack gap-lg">
        {#each Object.entries(grouped) as [group, entries]}
          <section>
            <h4 class="muted small">{group} · {entries.length}</h4>
            {#each entries as e}
              <div class="diff-row {e.type}">
                <span class="diff-path">{formatPath(e.path)}</span>
                {#if e.type === 'CREATE'}
                  + {short(e.value)}
                {:else if e.type === 'REMOVE'}
                  − {short(e.oldValue)}
                {:else}
                  {short(e.oldValue)} → {short(e.value)}
                {/if}
              </div>
            {/each}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
{:else if tab === 'schema'}
  {#if schemaRows.length === 0}
    <p class="muted">No readSchema/writeSchema properties to flatten.</p>
  {:else}
    <table class="schema-table">
      <thead>
        <tr>
          <th>Property</th>
          <th>Type</th>
          <th>Format</th>
          <th>Req</th>
          <th>Null</th>
          <th>Constraints</th>
        </tr>
      </thead>
      <tbody>
        {#each schemaRows as row}
          <tr>
            <td>
              <span class="schema-indent">{'  '.repeat(row.depth)}</span>{row.path}
            </td>
            <td class="dim">{row.type}</td>
            <td class="dim">{row.format}</td>
            <td class="req">{row.required ? '●' : ''}</td>
            <td class="nul">{row.nullable ? '○' : ''}</td>
            <td class="dim">{row.constraints}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{:else if tab === 'sample'}
  <div class="hist-controls">
    <div class="range-pills">
      <span class="range-lbl">docs:</span>
      {#each SAMPLE_LIMITS as n}
        <button
          type="button"
          class="range-pill"
          class:on={sampleLimit === n}
          onclick={() => (sampleLimit = n)}
        >{n}</button>
      {/each}
    </div>
    <button
      type="button"
      class="range-pill"
      onclick={() => (sampleFetchToken += 1)}
      disabled={sampleLoading}
    >↻ refresh</button>
    <span class="muted small" style="margin-left:auto">
      {#if sampleLoading}
        reading via <code>flowctl collections read --limit {sampleLimit}</code> …
      {:else if sampleDocs.length > 0}
        {sampleDocs.length} doc{sampleDocs.length === 1 ? '' : 's'}
      {/if}
    </span>
  </div>
  {#if sampleLoading}
    <p class="muted small">this can take 5–15s per request (flowctl connects to live journals)</p>
  {:else if sampleError}
    <div class="error-box">{sampleError}</div>
  {:else if sampleDocs.length === 0}
    <p class="muted small">no documents returned (collection may be empty or unreachable)</p>
  {:else}
    <div class="stack gap-lg">
      {#each sampleDocs as doc, i}
        <section>
          <h4 class="muted small">doc [{i}]</h4>
          <JsonView value={doc} />
        </section>
      {/each}
    </div>
  {/if}
{:else if tab === 'data'}
  <div class="hist-controls">
    <div class="range-pills">
      <span class="range-lbl">since:</span>
      {#each USAGE_RANGES as r}
        <button
          type="button"
          class="range-pill"
          class:on={!usageCustom && usageSince === r.value}
          onclick={() => { usageCustom = false; usageSince = r.value; }}
        >{r.label}</button>
      {/each}
      <button
        type="button"
        class="range-pill"
        class:on={usageCustom}
        onclick={() => (usageCustom = !usageCustom)}
      >custom…</button>
    </div>
    {#if usageCustom}
      <div class="range-pills">
        <span class="range-lbl">from:</span>
        <input type="date" bind:value={usageFrom} max={usageTo} class="date-input" />
        <span class="range-lbl">to:</span>
        <input type="date" bind:value={usageTo} max={new Date().toISOString().slice(0, 10)} class="date-input" />
      </div>
    {/if}
    <div class="range-pills">
      <span class="range-lbl">metric:</span>
      <button type="button" class="range-pill" class:on={usageMetric === 'bytes'} onclick={() => (usageMetric = 'bytes')}>Data</button>
      <button type="button" class="range-pill" class:on={usageMetric === 'docs'} onclick={() => (usageMetric = 'docs')}>Docs</button>
    </div>
    <span class="muted small" style="margin-left:auto">
      {#if usageLoading}reading via <code>flowctl raw stats</code>…{:else if usage}bucket · {usage.bucket} · {usage.fetchedRecords.toLocaleString()} txns{/if}
    </span>
  </div>
  {#if usageLoading}
    <div class="hint" style="margin-bottom:14px">
      <strong>First load can take 2–8 minutes</strong> for chatty CDC captures over long windows —
      flowctl streams every transaction. Once fetched the result is cached for <strong>15 minutes</strong>,
      so subsequent views + metric/window toggles are instant.
    </div>
  {/if}

  {#if usageLoading && !usage}
    <p class="muted small">this can take 5–30s per request (stats stream can be large)</p>
  {:else if usageError}
    <div class="error-box">{usageError}</div>
  {:else if usage}
    <div class="usage-cards">
      <div class="usage-card">
        <div class="uc-label">
          {specKind === 'capture' ? 'Data written to Flow' : 'Data read from Flow'}
        </div>
        <div class="uc-value">{fmtBytes(usage.total.bytes)}</div>
        <div class="uc-sub">
          {specKind === 'capture'
            ? 'Bytes this capture pushed INTO its collections'
            : 'Bytes this materialization pulled FROM its source collections'}
        </div>
      </div>
      <div class="usage-card">
        <div class="uc-label">Total documents</div>
        <div class="uc-value">{fmtDocs(usage.total.docs)}</div>
        <div class="uc-sub">{usage.total.txns.toLocaleString()} transactions</div>
      </div>
      <div class="usage-card">
        <div class="uc-label">Per hour (avg)</div>
        <div class="uc-value sub">{fmtBytes(usage.total.bytes / (usageSince === '24h' ? 24 : usageSince === '7d' ? 168 : 720))}</div>
        <div class="uc-sub">{fmtDocs(usage.total.docs / (usageSince === '24h' ? 24 : usageSince === '7d' ? 168 : 720))} docs/h</div>
      </div>
    </div>

    <div class="chart-header">
      <span class="chart-dot" style="background:{specKind === 'capture' ? '#7fbfff' : '#ffb547'}"></span>
      <span class="chart-title">
        {specKind === 'capture'
          ? (usageMetric === 'bytes' ? 'Data written to Flow' : 'Documents written to Flow')
          : (usageMetric === 'bytes' ? 'Data read from Flow' : 'Documents read from Flow')}
      </span>
      <span class="chart-help muted small">· bucket {usage.bucket} · hover a bar for exact value</span>
    </div>
    <div style="margin: 0 0 8px">
      <BarChart
        series={usage.series}
        valueKey={usageMetric}
        format={usageMetric === 'bytes' ? fmtBytes : fmtDocs}
        color={specKind === 'capture' ? '#7fbfff' : '#ffb547'}
      />
    </div>

    {#if Object.keys(usage.byBinding).length > 1}
      <h4 class="section-title">Per binding</h4>
      <table>
        <thead>
          <tr><th>Binding</th><th style="text-align:right">Data</th><th style="text-align:right">Docs</th><th style="text-align:right">Txns</th></tr>
        </thead>
        <tbody>
          {#each Object.entries(usage.byBinding).sort((a, b) => b[1].bytes - a[1].bytes) as [name, b]}
            <tr>
              <td class="mono-cell" style="font-size:11px">{name}</td>
              <td class="dim mono-cell" style="text-align:right">{fmtBytes(b.bytes)}</td>
              <td class="dim mono-cell" style="text-align:right">{fmtDocs(b.docs)}</td>
              <td class="dim mono-cell" style="text-align:right">{b.txns.toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
{/if}

<style>
  .section-title {
    color: var(--text);
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .section-title .section-sub {
    color: var(--text-mute);
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    font-size: 11px;
    margin-left: 6px;
  }
  .raw-model {
    margin-top: 24px;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 8px 14px;
  }
  .raw-model summary {
    cursor: pointer;
    color: var(--text-mute);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 6px 0;
    list-style: none;
  }
  .raw-model summary::-webkit-details-marker { display: none; }
  .raw-model summary::before { content: '▸ '; color: var(--accent); }
  .raw-model[open] summary::before { content: '▾ '; }
  :global(.pub-group summary) { grid-template-columns: 150px 90px 1fr auto !important; }
  :global(.pub-changes) { display: flex; gap: 4px; }
  :global(.pub-changes-list) { padding: 0 16px 14px; border-top: 1px dashed var(--line); }
  :global(.pub-changes-list h5) {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--text-mute); font-weight: 600; margin: 12px 0 8px;
  }
  :global(.pub-changes-list .diff) { max-height: 400px; overflow-y: auto; }

  .hist-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 12px 16px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    margin-bottom: 16px;
  }
  .hist-controls label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    color: var(--text-dim);
  }
  .hist-controls label b { color: var(--accent); font-family: var(--font-mono); font-size: 13px; }
  .range-pills {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-right: 12px;
    border-right: 1px solid var(--line);
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
  .range-pill:hover { color: var(--text); border-color: var(--text-mute); }
  .range-pill.on {
    background: rgba(208, 255, 63, 0.08);
    color: var(--accent);
    border-color: var(--accent);
  }
  .usage-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 4px;
  }
  .usage-card {
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .uc-label {
    color: var(--text-dim);
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .uc-value {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .uc-value.sub { font-size: 18px; }
  .uc-sub {
    color: var(--text-mute);
    font-size: 10.5px;
    font-family: var(--font-mono);
    margin-top: auto;
  }
  .date-input {
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 3px;
    color-scheme: dark;
  }
  .date-input:focus { border-color: var(--accent); outline: none; }
  .chart-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px 8px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    margin-top: 20px;
  }
  .chart-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .chart-title { color: var(--text); font-family: var(--font-mono); font-size: 12px; font-weight: 500; }
  .chart-help { margin-left: auto; }
</style>
