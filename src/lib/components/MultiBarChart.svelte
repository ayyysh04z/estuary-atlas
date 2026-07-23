<script lang="ts">
  // Grouped bar chart — two (or more) series sharing an x-axis, thin bars
  // side by side per bucket so you can compare in/out at a glance.
  interface Bucket { ts: string; [k: string]: number | string }
  interface SeriesDef { key: string; label: string; color: string }
  let {
    data,
    series,
    format = (v: number) => v.toString()
  }: {
    data: Bucket[];
    series: SeriesDef[];
    format?: (v: number) => string;
  } = $props();

  const max = $derived(
    Math.max(1, ...data.flatMap((b) => series.map((s) => Number(b[s.key] ?? 0))))
  );
  const W = 960;
  const H = 340;
  const P = { top: 20, right: 20, bottom: 40, left: 72 };
  const chartW = $derived(W - P.left - P.right);
  const chartH = $derived(H - P.top - P.bottom);
  const groupW = $derived(data.length ? chartW / data.length : 0);
  const barW = $derived(Math.max(1.5, (groupW - 4) / series.length));

  const gridValues = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * max));

  function fmtShort(ts: string): string {
    const d = new Date(ts);
    return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getUTCDate()}`;
  }

  let hover = $state<{ i: number; x: number; y: number } | null>(null);
</script>

<div class="chart-wrap">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Grouped bar chart">
    <!-- gridlines + y-axis labels -->
    {#each gridValues as v, i}
      {@const y = P.top + chartH - (v / max) * chartH}
      <line x1={P.left} y1={y} x2={W - P.right} y2={y}
            stroke="var(--line)" stroke-dasharray={i === 0 ? '' : '3 4'} />
      <text x={P.left - 8} y={y + 4} text-anchor="end"
            font-size="10" fill="var(--text-mute)" font-family="var(--font-mono)">
        {format(v)}
      </text>
    {/each}

    <!-- grouped bars -->
    {#each data as b, i}
      {@const groupX = P.left + i * groupW + 2}
      {#each series as s, si}
        {@const v = Number(b[s.key] ?? 0)}
        {@const h = (v / max) * chartH}
        {@const x = groupX + si * (barW + 1)}
        {@const y = P.top + chartH - h}
        <rect
          {x} {y} width={barW} height={h}
          fill={s.color}
          fill-opacity="0.9"
          onmouseenter={() => (hover = { i, x: groupX + groupW / 2, y })}
          onmouseleave={() => (hover = null)}
          role="presentation"
        />
      {/each}
    {/each}

    <!-- x-axis ticks — every Nth for readability -->
    {#each data as b, i}
      {#if data.length <= 12 || i % Math.ceil(data.length / 8) === 0}
        {@const x = P.left + i * groupW + groupW / 2}
        <text {x} y={H - 14} text-anchor="middle"
              font-size="10" fill="var(--text-mute)" font-family="var(--font-mono)">
          {fmtShort(String(b.ts))}
        </text>
      {/if}
    {/each}

    <!-- hover tooltip -->
    {#if hover}
      {@const b = data[hover.i]}
      <g pointer-events="none">
        <line x1={hover.x} y1={P.top} x2={hover.x} y2={P.top + chartH} stroke="var(--accent)" stroke-opacity="0.5" />
        <g transform="translate({Math.min(hover.x + 8, W - 200)},{Math.max(hover.y - 60, P.top + 8)})">
          <rect x="0" y="0" width="200" height={20 + series.length * 16} fill="var(--bg-3)" stroke="var(--line-strong)" rx="3" />
          <text x="10" y="16" fill="var(--text)" font-size="11" font-family="var(--font-mono)">
            {new Date(String(b.ts)).toISOString().slice(0, 16)}Z
          </text>
          {#each series as s, si}
            <circle cx="16" cy={32 + si * 16} r="5" fill={s.color} />
            <text x="26" y={36 + si * 16} font-size="11" font-family="var(--font-mono)" fill="var(--text-dim)">
              {s.label}
            </text>
            <text x="192" y={36 + si * 16} text-anchor="end" fill="var(--text)"
                  font-size="11.5" font-weight="600" font-family="var(--font-mono)">
              {format(Number(b[s.key] ?? 0))}
            </text>
          {/each}
        </g>
      </g>
    {/if}
  </svg>
</div>

<style>
  .chart-wrap {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 0 0 4px 4px;
    padding: 12px;
  }
  svg { width: 100%; display: block; }
  rect:hover { fill-opacity: 1; }
</style>
