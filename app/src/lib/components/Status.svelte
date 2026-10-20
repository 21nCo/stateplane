<script lang="ts">
  let { tone='neutral', children }:{ tone?:'neutral'|'success'|'warning'|'danger'; children:import('svelte').Snippet } = $props();
  const tones={neutral:'border-line text-subtle',success:'border-success text-success',warning:'border-warning text-warning',danger:'border-danger text-danger'};
</script>

<span class="inline-block rounded-full border px-2 py-0.5 text-xs font-semibold {tones[tone]}">{@render children()}</span>
