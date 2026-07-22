<script lang="ts">
  import { flattenSchema, resolveSchema } from '$lib/schema';
  let { schema, maxDepth = 6 }: { schema: unknown; maxDepth?: number } = $props();

  const rows = $derived(flattenSchema(schema, maxDepth));

  const rootMeta = $derived.by(() => {
    if (!schema || typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;
    const s = schema as Record<string, unknown>;
    const defs = (s['$defs'] as Record<string, unknown> | undefined) ?? {};
    const inferred = 'flow://inferred-schema' in defs;
    const connector = 'flow://connector-schema' in defs;
    const resolved = resolveSchema(schema) ?? s;
    return {
      strict: resolved['additionalProperties'] === false,
      openTree: resolved['additionalProperties'] === true,
      inferred,
      connector,
      required: Array.isArray(resolved['required']) ? (resolved['required'] as string[]).length : 0,
      propCount: rows.length
    };
  });

  function niceType(t: string): string {
    return t.replace(/\|/g, ' | ');
  }
  function shortConstraints(c: string): { key: string; value: string }[] {
    if (!c) return [];
    return c.split(' ').filter(Boolean).map((p) => {
      const [k, ...v] = p.split('=');
      return { key: k.replace(/^x-str-/, 'str-'), value: v.join('=').replace(/^"|"$/g, '') };
    });
  }
</script>

{#if rows.length === 0}
  <p class="muted small">No properties to render (schema may be a $ref or empty).</p>
{:else}
  <div class="sv">
    {#if rootMeta}
      <div class="sv-meta">
        {#if rootMeta.strict}<span class="chip modified">strict-props</span>{/if}
        {#if rootMeta.openTree}<span class="chip warm">additionalProperties:true</span>{/if}
        {#if rootMeta.inferred}<span class="chip modified">inferred-schema</span>{/if}
        {#if rootMeta.connector}<span class="chip default">connector-schema</span>{/if}
        <span class="chip info">{rootMeta.propCount} props</span>
        <span class="chip info">{rootMeta.required} required</span>
      </div>
    {/if}
    <table class="sv-table">
      <thead>
        <tr>
          <th>Property</th>
          <th>Type</th>
          <th>Flags</th>
          <th>Constraints</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row}
          <tr class:req={row.required} class:nul={row.nullable}>
            <td class="sv-path">
              <span class="sv-marker">
                {#if row.required}<span class="mk req">●</span>{:else if row.nullable}<span class="mk nul">○</span>{:else}<span class="mk">·</span>{/if}
              </span>
              <span class="sv-indent" style:padding-left="{row.depth * 18}px">{row.path.split('.').pop() ?? row.path}</span>
              {#if row.path.includes('.')}
                <div class="sv-full">{row.path}</div>
              {/if}
            </td>
            <td>
              <span class="sv-type">{niceType(row.type)}</span>
              {#if row.format}<span class="sv-fmt">/ {row.format}</span>{/if}
            </td>
            <td class="sv-flags">
              {#if row.required}<span class="chip modified" style="font-size:9px">required</span>{/if}
              {#if row.nullable}<span class="chip warm" style="font-size:9px">nullable</span>{/if}
            </td>
            <td class="sv-cons">
              {#each shortConstraints(row.constraints) as c}
                <span class="sv-c"><b>{c.key}</b>{c.value}</span>
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .sv-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; padding: 10px 12px; background: var(--bg-3); border: 1px solid var(--line); border-radius: 3px; }
  .sv-table { width: 100%; border-collapse: collapse; }
  .sv-table th { position: sticky; top: 0; }
  .sv-table td, .sv-table th { padding: 7px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 12.5px; }
  .sv-table tbody tr:hover td { background: var(--bg-3); }
  .sv-path { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); position: relative; }
  .sv-marker { display: inline-block; width: 16px; }
  .mk { display: inline-block; width: 12px; text-align: center; }
  .mk.req { color: var(--accent); font-weight: 700; }
  .mk.nul { color: var(--accent-warm); }
  .sv-indent { color: var(--text); }
  tr.req .sv-indent { color: var(--text); font-weight: 500; }
  .sv-full { color: var(--text-mute); font-size: 10.5px; margin-top: 2px; margin-left: 16px; font-family: var(--font-mono); }
  .sv-type { color: var(--accent-cool); font-family: var(--font-mono); font-size: 11.5px; }
  .sv-fmt { color: var(--text-mute); font-family: var(--font-mono); font-size: 10.5px; margin-left: 4px; }
  .sv-flags { min-width: 120px; }
  .sv-flags :global(.chip) { margin-right: 4px; }
  .sv-cons { color: var(--text-dim); font-family: var(--font-mono); font-size: 10.5px; }
  .sv-c { display: inline-block; margin-right: 8px; background: var(--bg-3); padding: 1px 6px; border: 1px solid var(--line); border-radius: 2px; }
  .sv-c b { color: var(--accent-cool); font-weight: 500; margin-right: 3px; }
</style>
