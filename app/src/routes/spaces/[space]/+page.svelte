<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Status from '$lib/components/Status.svelte';
  let { data, form } = $props();
  const base=$derived(`/spaces/${encodeURIComponent(data.spaceId)}`);
  const placement=$derived(data.space ? [['Lifecycle',data.space.lifecycle],['Home cell',data.space.homeCellId],
    ['Current cell',data.space.cellId],['Storage target',data.space.storageTargetId],
    ['Placement generation',data.space.placementGeneration],['Policy version',data.space.policyVersion]] : []);
</script>

<svelte:head><title>Space · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Space overview</h1>
<div class="mt-4 grid gap-6 lg:grid-cols-[1fr_2fr]">
  <section aria-labelledby="placement" class="panel space-y-3">
    <h2 id="placement" class="text-lg font-semibold">Placement</h2>
    {#if data.space}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {#each placement as [term,value] (term)}<dt class="text-subtle">{term}</dt><dd class="break-all">{value}</dd>{/each}
      </dl>
      <p class="hint">The service routes every request to this placement; the UI cannot choose another cell.</p>
      <Notice error={form?.lifecycleError} title="Lifecycle was not changed" />
      {#if form?.lifecycleSaved}<p role="status" class="text-sm text-success">Lifecycle updated.</p>{/if}
      <form method="POST" action="?/lifecycle" class="flex items-end gap-2">
        <div class="grow"><label for="lifecycle">Lifecycle</label>
          <select id="lifecycle" name="lifecycle">{#each ['active','readOnly','suspended'] as value (value)}<option selected={value===data.space.lifecycle}>{value}</option>{/each}</select></div>
        <button class="btn-quiet">Apply</button>
      </form>
    {:else}
      <Notice error={data.spaceError} title="Placement is not visible to this credential" />
    {/if}
  </section>
  <section aria-labelledby="collections" class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="collections" class="text-lg font-semibold">Collections</h2>
      {#if data.space}<a class="btn" href="{base}/collections/new">Define collection</a>{/if}
    </div>
    <Notice error={data.error} title="Collections could not be listed" />
    {#if data.collections}
      {#if data.collections.items.length}
        <ul class="space-y-2">{#each data.collections.items as item (item.definition.slug)}
          <li class="panel flex flex-wrap items-center justify-between gap-2">
            <a class="link font-mono" href="{base}/collections/{encodeURIComponent(item.definition.slug)}">{item.definition.slug}</a>
            <span class="flex flex-wrap gap-2 text-sm">
              <Status>schema v{item.definition.version}</Status>
              {#if item.pending.length}<Status tone="warning">{item.pending.length} index pending</Status>{/if}
            </span>
          </li>{/each}</ul>
      {:else}
        <p class="panel hint">No collections are visible. An owner can define one; an agent sees only granted collections.</p>
      {/if}
      <nav aria-label="Collection pages" class="flex gap-3">
        {#if data.cursor}<a class="link" href={base}>First page</a>{/if}
        {#if data.collections.cursor}<a class="link" href="{base}?cursor={encodeURIComponent(data.collections.cursor)}">Next page</a>{/if}
      </nav>
    {/if}
  </section>
</div>
