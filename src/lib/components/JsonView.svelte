<script lang="ts">
  import { highlightJson } from '$lib/json-view';
  let { value }: { value: unknown } = $props();
  const html = $derived(highlightJson(value));
</script>

<pre class="json">{@html html}</pre>
