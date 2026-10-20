<script lang="ts">
  let { label, children }:{ label:string; children:import('svelte').Snippet } = $props();
</script>

<!-- A wide table scrolls inside this labelled region, which keyboard users can focus and scroll. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="panel overflow-x-auto p-0" role="region" aria-label={label} tabindex="0">{@render children()}</div>
