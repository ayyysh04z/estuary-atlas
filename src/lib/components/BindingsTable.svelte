<script lang="ts">
  type Obj = Record<string, unknown>;
  let { bindings, kind }: { bindings: unknown; kind: 'capture' | 'materialization' } = $props();

  const rows = $derived.by(() => {
    if (!Array.isArray(bindings)) return [] as Obj[];
    return bindings as Obj[];
  });

  function resourceOf(b: Obj): Obj {
    return (b['resource'] as Obj) ?? {};
  }
  function fieldsOf(b: Obj): { require: string[]; exclude: string[]; recommended: unknown } {
    const f = (b['fields'] as Obj) ?? {};
    return {
      require: Object.keys((f['require'] as Obj) ?? {}),
      exclude: Array.isArray(f['exclude']) ? (f['exclude'] as string[]) : [],
      recommended: f['recommended']
    };
  }
</script>

{#if rows.length === 0}
  <p class="muted small">No bindings.</p>
{:else}
  <table>
    <thead>
      <tr>
        {#if kind === 'capture'}
          <th>Target collection</th>
          <th>Resource</th>
          <th>Interval</th>
          <th>Backfill</th>
        {:else}
          <th>Source collection</th>
          <th>Target table</th>
          <th>Delta</th>
          <th>Pinned</th>
          <th>Excluded</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as b}
        {@const res = resourceOf(b)}
        {@const f = fieldsOf(b)}
        {#if kind === 'capture'}
          <tr>
            <td class="mono-cell">{String(b.target ?? '')}</td>
            <td class="dim mono-cell">
              {String(res.name ?? res.stream ?? res.table ?? '')}
              {#if Array.isArray(res._meta && (res._meta as Obj).path)}
                <span class="dim"> · path: {((res._meta as Obj).path as string[]).join('/')}</span>
              {/if}
            </td>
            <td class="dim">{String(res.interval ?? '')}</td>
            <td class="dim">
              {#if res.syncMode}<span class="chip info" style="font-size:9px">{res.syncMode}</span>{/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td class="mono-cell">{String(b.source ?? '')}</td>
            <td class="mono-cell">{String(res.table ?? '')}</td>
            <td class="dim">
              {#if res.delta_updates || b.deltaUpdates}<span class="chip modified" style="font-size:9px">delta</span>{:else}—{/if}
            </td>
            <td>
              {#each f.require as name}
                <span class="chip modified" style="font-size:9px">{name}</span>
              {/each}
              {#if f.require.length === 0}<span class="dim">—</span>{/if}
            </td>
            <td>
              {#each f.exclude as name}
                <span class="chip warm" style="font-size:9px">{name}</span>
              {/each}
              {#if f.exclude.length === 0}<span class="dim">—</span>{/if}
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
{/if}
