<script lang="ts">
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();

  const totals = $derived({
    pipelines: data.cards.length,
    sources: data.cards.reduce((s, c) => s + c.sources, 0),
    collections: data.cards.reduce((s, c) => s + c.collections, 0),
    destinations: data.cards.reduce((s, c) => s + c.destinations, 0)
  });
</script>

<div class="pagehead">
  <h1>Pipelines</h1>
  <span class="breadcrumb">live counts via flowctl catalog list</span>
</div>

<div class="statsbar mt-lg">
  <div class="stat"><span class="stat-label">pipelines</span><span class="stat-num">{totals.pipelines}</span></div>
  <div class="stat"><span class="stat-label">sources</span><span class="stat-num">{totals.sources}</span></div>
  <div class="stat"><span class="stat-label">collections</span><span class="stat-num">{totals.collections}</span></div>
  <div class="stat"><span class="stat-label">destinations</span><span class="stat-num">{totals.destinations}</span></div>
</div>

<div class="grid mt-lg">
  {#each data.cards as card}
    <a href="/{card.slug}" style="text-decoration:none;color:inherit">
      <div class="card">
        <h3>{card.slug}</h3>
        {#if card.error}
          <div class="chip danger" title={card.error}>error</div>
        {:else}
          <div class="counts">
            <span><b>{card.sources}</b> captures</span>
            <span><b>{card.collections}</b> collections</span>
            <span><b>{card.destinations}</b> materializations</span>
          </div>
        {/if}
      </div>
    </a>
  {/each}
</div>
