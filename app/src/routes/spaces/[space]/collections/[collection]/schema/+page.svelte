<script lang="ts">
  import DefinitionForm from '$lib/components/DefinitionForm.svelte';
  import Notice from '$lib/components/Notice.svelte';
  import Status from '$lib/components/Status.svelte';
  let { data, form } = $props();
  const editable=$derived(data.collection ? (({slug:_slug,version:_version,...rest})=>JSON.stringify(rest,null,2))(data.collection.definition) : '');
  const records=$derived(`/spaces/${encodeURIComponent(data.spaceId)}/collections/${encodeURIComponent(data.collection?.definition.slug ?? '')}`);
</script>

<svelte:head><title>Schema · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Schema</h1>
<Notice error={data.error} title="Collection could not be read" />
{#if data.collection}
  <p class="mt-1"><span class="font-mono">{data.collection.definition.slug}</span> · version {data.collection.definition.version} · <a class="link" href={records}>Records</a></p>
  <div class="mt-4 grid gap-6 lg:grid-cols-[1fr_2fr]">
    <section aria-labelledby="indexes" class="panel space-y-3">
      <h2 id="indexes" class="text-lg font-semibold">Filter and sort indexes</h2>
      <Notice error={form?.backfillError} title="Index was not built" />
      {#if form?.field && !form?.backfillError}<p role="status" class="text-sm {form.ready ? 'text-success' : 'text-warning'}">{form.ready ? `Index ${form.field} is ready.` : `Index ${form.field} is still building; build again to continue.`}</p>{/if}
      <ul class="space-y-2">
        {#each data.collection.ready as field (field)}<li class="flex items-center justify-between gap-2"><span class="font-mono">{field}</span><Status tone="success">ready</Status></li>{/each}
        {#each data.collection.pending as field (field)}<li class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono">{field}</span><Status tone="warning">pending</Status>
          <form method="POST" action="?/backfill"><input type="hidden" name="field" value={field} /><button class="btn-quiet">Build {field} index</button></form>
        </li>{/each}
      </ul>
      {#if !data.collection.ready.length && !data.collection.pending.length}<p class="hint">No filter or sort fields are declared.</p>{/if}
      <p class="hint">A pending index is not used for filters or sorting until it is ready, so results are never partial.</p>
    </section>
    <section aria-labelledby="revise" class="panel space-y-3">
      <h2 id="revise" class="text-lg font-semibold">Revise definition</h2>
      {#if form?.revised}<p role="status" class="text-sm text-success">Saved as version {data.collection.definition.version}.</p>{/if}
      <DefinitionForm action="?/revise" definition={form?.definition ?? editable} invalid={form?.invalid} error={form?.error} submit="Save revision">
        <input type="hidden" name="version" value={form?.version ?? data.collection.definition.version} />
        {#if form?.error?.code==='SCHEMA_CONFLICT'}<p class="text-sm">Another revision was saved first; your edit was not applied. <a class="link" href="?">Discard my edit and load version {data.collection.definition.version}</a></p>{/if}
      </DefinitionForm>
    </section>
  </div>
{/if}
