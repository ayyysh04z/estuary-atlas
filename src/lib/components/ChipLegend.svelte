<script lang="ts">
  interface LegendItem {
    label: string;
    kind: 'default' | 'modified' | 'info';
    desc: string;
    group: 'Defaults' | 'Modifications' | 'Info';
  }

  const LEGEND: LegendItem[] = [
    // Defaults
    { label: 'default-read', kind: 'default', desc: 'collection uses connector-default readSchema', group: 'Defaults' },
    { label: 'connector-write', kind: 'default', desc: 'writeSchema references a connector $ref', group: 'Defaults' },
    // Modifications
    { label: 'autoDiscover', kind: 'modified', desc: 'capture auto-adds/evolves bindings', group: 'Modifications' },
    { label: 'autoDiscover-off', kind: 'modified', desc: 'capture autoDiscover disabled', group: 'Modifications' },
    { label: 'runtime-v2', kind: 'modified', desc: 'shard flag enable-runtime-v2 set', group: 'Modifications' },
    { label: 'inferred-read', kind: 'modified', desc: 'readSchema is estuary-inferred', group: 'Modifications' },
    { label: 'custom-read', kind: 'modified', desc: 'readSchema references a custom file', group: 'Modifications' },
    { label: 'inline-schema', kind: 'modified', desc: 'readSchema defined inline in spec', group: 'Modifications' },
    { label: 'custom-write', kind: 'modified', desc: 'writeSchema overridden manually', group: 'Modifications' },
    { label: 'strict-props', kind: 'modified', desc: 'additionalProperties: false on readSchema', group: 'Modifications' },
    { label: 'deltaUpdates', kind: 'modified', desc: 'materialization uses source.deltaUpdates', group: 'Modifications' },
    { label: 'pinned-fields×N', kind: 'modified', desc: 'bindings with explicit fields.require map', group: 'Modifications' },
    { label: 'delta×N', kind: 'modified', desc: 'bindings with resource.delta_updates', group: 'Modifications' },
    { label: 'excluded×N', kind: 'modified', desc: 'bindings with fields.exclude list', group: 'Modifications' },
    // Info
    { label: 'synthetic-key', kind: 'info', desc: 'collection key contains /_meta/ paths', group: 'Info' },
    { label: 'composite-key×N', kind: 'info', desc: 'collection key spans multiple fields', group: 'Info' }
  ];

  const groups = ['Defaults', 'Modifications', 'Info'] as const;
</script>

<details class="legend-details" open>
  <summary>Chip legend</summary>
  {#each groups as g}
    <div class="legend-group">
      <h5>{g}</h5>
      <div class="legend-grid">
        {#each LEGEND.filter((l) => l.group === g) as item}
          <div class="legend-row">
            <span class="chip {item.kind}">{item.label}</span>
            <span>·</span>
            <span>{item.desc}</span>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</details>
