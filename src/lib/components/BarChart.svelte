<script lang="ts">
  let {
    series,
    valueKey = 'bytes',
    format = (v: number) => v.toString(),
    color = 'var(--accent-cool)'
  }: {
    series: Array<{ ts: string; bytes: number; docs: number }>;
    valueKey?: 'bytes' | 'docs';
    format?: (v: number) => string;
    color?: string;
  } = $props();

  const max = $derived(Math.max(1, ...series.map((s) => s[valueKey])));
  const W = 900;
  const H = 260;
  const P = { top: 16, right: 16, bottom: 32, left: 60 };
  const chartW = $derived(W - P.left - P.right);
  const chartH = $derived(H - P.top - P.bottom);
  const barW = $derived(series.length ? Math.max(2, chartW / series.length - 4) : 0);

  // 4 gridlines
  const gridValues = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * max));

  function fmtShort(ts: string): string {
    const d = new Date(ts);
    // Mon DD  HH:00
    const mo = d.toLocaleString('en-US', { month: 'short' });
    return `${mo} ${d.getUTCDate()}`;
  }

  let hover = $state<{ idx: number; x: number; y: number } | null>(null);
</script>

<div class="chart-wrap" style="--chart-color: {color}">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Usage bar chart">
    <!-- gridlines + axis labels -->
    {#each gridValues as v, i}
      {@const y = P.top + chartH - (v / max) * chartH}
      <line x1={P.left} y1={y} x2={W - P.right} y2={y}
            stroke="var(--line)" stroke-dasharray={i === 0 ? '' : '3 4'} />
      <text x={P.left - 8} y={y + 4} text-anchor="end"
            font-size="10" fill="var(--text-mute)" font-family="var(--font-mono)">
        {format(v)}
      </text>
    {/each}

    <!-- bars -->
    {#each series as s, i}
      {@const v = s[valueKey]}
      {@const h = (v / max) * chartH}
      {@const x = P.left + i * (chartW / series.length) + 2}
      {@const y = P.top + chartH - h}
      <rect
        {x} {y} width={barW} height={h}
        fill="var(--chart-color)" fill-opacity="0.85"
        onmouseenter={() => (hover = { idx: i, x: x + barW / 2, y })}
        onmouseleave={() => (hover = null)}
        role="presentation"
      >
        <title>{fmtShort(s.ts)} {new Date(s.ts).toISOString().slice(11,16)}Z · {format(v)} · {s.docs.toLocaleString()} docs</title>
      </rect>
    {/each}

    <!-- x labels: every Nth tick to avoid crowding -->
    {#each series as s, i}
      {#if series.length <= 12 || i % Math.ceil(series.length / 8) === 0}
        {@const x = P.left + i * (chartW / series.length) + barW / 2 + 2}
        <text {x} y={H - 14} text-anchor="middle"
              font-size="10" fill="var(--text-mute)" font-family="var(--font-mono)">
          {fmtShort(s.ts)}
        </text>
      {/if}
    {/each}

    <!-- hover tooltip -->
    {#if hover}
      {@const s = series[hover.idx]}
      {@const v = s[valueKey]}
      <g pointer-events="none">
        <line x1={hover.x} y1={P.top} x2={hover.x} y2={P.top + chartH} stroke="var(--accent)" stroke-opacity="0.5" />
        <g transform="translate({Math.min(hover.x + 8, W - 170)},{Math.max(hover.y - 40, P.top + 8)})">
          <rect x="0" y="0" width="160" height="42" fill="var(--bg-3)" stroke="var(--line-strong)" rx="3" />
          <text x="8" y="16" fill="var(--text)" font-size="11" font-family="var(--font-mono)">
            {new Date(s.ts).toISOString().slice(0, 16)}Z
          </text>
          <text x="8" y="32" fill="var(--accent)" font-size="12" font-family="var(--font-mono)" font-weight="600">
            {format(v)}
          </text>
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
    border-radius: 4px;
    padding: 12px;
  }
  svg { width: 100%; display: block; }
  rect:hover { fill-opacity: 1; }
</style>
