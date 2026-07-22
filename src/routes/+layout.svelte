<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { PIPELINES } from '$lib/pipelines';
  import ChipLegend from '$lib/components/ChipLegend.svelte';

  let { children } = $props();
  let legendOpen = $state(false);

  const currentSlug = $derived($page.params.pipeline);
</script>

<div class="app">
  <header class="topbar">
    <div class="brand"><a href="/">estuary atlas</a></div>
    <span class="muted">{PIPELINES.length} pipelines · live via flowctl</span>
    <span style="flex:1"></span>
    <button
      class="legend-btn"
      class:on={legendOpen}
      onclick={() => (legendOpen = !legendOpen)}
      title="Show chip legend"
    >
      {legendOpen ? '▾' : '▸'} chip legend
    </button>
    <span class="muted mono">read-only</span>
  </header>

  {#if legendOpen}
    <div class="legend-drawer">
      <ChipLegend />
    </div>
  {/if}

  <nav class="sidebar">
    <h4>Pipelines</h4>
    {#each PIPELINES as p}
      <a href="/{p.slug}" class:active={currentSlug === p.slug}>{p.slug}</a>
    {/each}
  </nav>

  <main class="main">
    {@render children()}
  </main>
</div>

<style>
  .legend-btn {
    background: transparent;
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 5px 12px;
    border-radius: 3px;
    cursor: pointer;
    margin-right: 16px;
  }
  .legend-btn:hover, .legend-btn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(208, 255, 63, 0.06);
  }
  .legend-drawer {
    position: fixed;
    top: 52px;
    left: 0;
    right: 0;
    z-index: 25;
    background: var(--bg-2);
    border-bottom: 1px solid var(--line);
    padding: 20px 36px;
    max-height: 60vh;
    overflow-y: auto;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .legend-drawer :global(.legend-details) {
    margin-top: 0;
    border: none;
    background: transparent;
    padding: 0;
  }
  .legend-drawer :global(.legend-details summary) {
    display: none;
  }
  .legend-drawer :global(.legend-grid) {
    padding-top: 0;
  }
</style>
