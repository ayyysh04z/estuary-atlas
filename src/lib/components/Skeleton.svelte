<script lang="ts">
  let {
    rows = 3,
    width = '100%',
    height = '20px',
    label = ''
  }: { rows?: number; width?: string; height?: string; label?: string } = $props();
</script>

{#if label}
  <div class="sk-label">{label}</div>
{/if}
<div class="sk-stack">
  {#each Array(rows) as _, i}
    <div class="sk-row" style:height style:width={i === rows - 1 ? '70%' : width}></div>
  {/each}
</div>

<style>
  .sk-label {
    color: var(--text-mute);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .sk-stack { display: flex; flex-direction: column; gap: 8px; }
  .sk-row {
    background: linear-gradient(
      90deg,
      var(--bg-2) 0%,
      var(--bg-3) 50%,
      var(--bg-2) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 3px;
  }
  @keyframes shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
</style>
