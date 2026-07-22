<script lang="ts">
  let { data, prefix = '' }: { data: unknown; prefix?: string } = $props();

  interface Row { key: string; value: string; deep?: boolean }

  function flatten(v: unknown, base: string): Row[] {
    if (v === null || v === undefined) return [{ key: base, value: '(null)' }];
    if (typeof v !== 'object') return [{ key: base, value: String(v) }];
    if (Array.isArray(v)) {
      if (v.length === 0) return [{ key: base, value: '[]' }];
      if (v.every((x) => typeof x !== 'object' || x === null)) {
        return [{ key: base, value: v.map((x) => String(x)).join(', ') }];
      }
      const out: Row[] = [];
      v.forEach((x, i) => out.push(...flatten(x, `${base}[${i}]`)));
      return out;
    }
    const rec = v as Record<string, unknown>;
    const out: Row[] = [];
    for (const [k, val] of Object.entries(rec)) {
      const key = base ? `${base}.${k}` : k;
      out.push(...flatten(val, key));
    }
    return out;
  }

  const rows = $derived(flatten(data, prefix));
</script>

<dl class="kv">
  {#each rows as row}
    <dt>{row.key}</dt>
    <dd>{row.value}</dd>
  {/each}
</dl>

<style>
  .kv {
    display: grid;
    grid-template-columns: minmax(180px, auto) 1fr;
    gap: 4px 24px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  dt {
    color: var(--text-mute);
    padding: 6px 0;
    border-bottom: 1px dashed var(--line);
    word-break: break-all;
  }
  dd {
    color: var(--text);
    margin: 0;
    padding: 6px 0;
    border-bottom: 1px dashed var(--line);
    word-break: break-all;
  }
</style>
