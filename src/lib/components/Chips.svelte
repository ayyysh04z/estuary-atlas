<script lang="ts">
  import type { Chip } from '$lib/chips';
  let { chips }: { chips: Chip[] } = $props();
</script>

<div class="chips">
  {#each chips as c}
    <span class="chip {c.kind}">{c.label}</span>
  {/each}
</div>
