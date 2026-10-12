<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Restart from '$lib/components/Restart.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import Unresolved from '$lib/components/Unresolved.svelte';
  import { maxUnresolved } from '$lib/errors';
  import { fieldKind, operators } from '$lib/query';
  import { page } from '$app/state';
  import { carry, collectionHref, segment, selectors, shown } from '$lib/paths';
  let { data, form } = $props();
  const definition=$derived(data.collection?.definition);
  const base=$derived(collectionHref(data.spaceId,selectors(page.url).collection));
  const filterable=$derived(data.collection ? definition!.filterable.filter(field=>data.collection!.ready.includes(field)) : []);
  const sortable=$derived(data.collection ? definition!.sortable.filter(field=>data.collection!.ready.includes(field)) : []);
  const pending=$derived(data.collection?.pending ?? []);
  const schemaInvalid=$derived(form?.create?.invalid || form?.create?.error?.code==='SCHEMA_INVALID');
  // Unresolved creates stay on the page, whatever later drafts return.
  const unresolved=$derived(form?.pending ?? []);
  const draft=$derived(form?.create ?? form?.draft ?? null);
  const columns=$derived(Object.keys(definition?.schema.properties ?? {}).slice(0,4));
  const rows=$derived([...data.rows,{field:'',op:'eq',value:''}]);
  const query=$derived.by(()=>{
    const params=new URLSearchParams();
    for (const row of data.rows) { params.append('field',carry(row.field)); params.append('op',row.op); params.append('value',row.value); }
    if (data.sort) { params.set('sort',carry(data.sort.field)); params.set('dir',data.sort.direction); }
    params.set('limit',String(data.limit));
    return params;
  });
  const next=$derived(data.page?.nextCursor ? `${base}?${query}&cursor=${encodeURIComponent(data.page.nextCursor)}` : null);
  const cell=(record:{canonicalData:string},column:string)=>{ const value=(JSON.parse(record.canonicalData) as Record<string,unknown>)[column]; return value===undefined ? '—' : typeof value==='string' ? value : JSON.stringify(value); };
</script>

<svelte:head><title>Records · Stateplane</title></svelte:head>
<Notice error={data.collection ? null : data.error} title="Collection could not be read" />
{#if data.collection && definition}
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="min-w-0 text-2xl font-semibold">Records in <span class="ident">{shown(definition.slug)}</span></h1>
    <p class="flex flex-wrap gap-4 text-sm"><a class="link" href="{base}/schema">Schema v{definition.version}</a><a class="link" href="{base}/events">Changes</a><a class="link" href="{base}/batches">Ingestion</a></p>
  </div>
  {#if pending.length}<p class="mt-2 text-sm text-warning" role="status">Indexes pending for {#each pending as field, index (field)}{index ? ', ' : ''}<span class="ident">{shown(field)}</span>{/each}. They cannot be filtered or sorted until built on the schema page.</p>{/if}
  <div class="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
    <section aria-labelledby="results" class="min-w-0 space-y-3">
      <form method="GET" class="panel space-y-3" aria-labelledby="filter-title">
        <h2 id="filter-title" class="font-semibold">Filter and sort</h2>
        {#each rows as row, index (index)}
          <fieldset class="grid gap-2 sm:grid-cols-3">
            <legend class="sr-only">Filter {index+1}</legend>
            <div><label for="field-{index}">Field</label>
              <select id="field-{index}" name="field"><option value="">{index===data.rows.length ? 'Add a filter…' : 'Remove filter'}</option>
                {#each filterable as field (field)}<option value={carry(field)} selected={field===row.field}>{shown(field)} ({fieldKind(definition,field)})</option>{/each}</select></div>
            <div><label for="op-{index}">Operator</label>
              <select id="op-{index}" name="op">{#each operators as op (op)}<option selected={op===row.op}>{op}</option>{/each}</select></div>
            <div><label for="value-{index}">Value</label>
              <input id="value-{index}" name="value" value={row.value} aria-invalid={data.filterErrors[index] ? 'true' : undefined}
                aria-describedby={data.filterErrors[index] ? `value-error-${index}` : undefined} />
              {#if data.filterErrors[index]}<p id="value-error-{index}" class="mt-1 text-sm text-danger">{data.filterErrors[index]}</p>{/if}</div>
          </fieldset>
        {/each}
        <p class="hint">Use <code>in</code> with comma-separated values; text matches exactly, including spaces after commas; <code>isNull</code> ignores the value.</p>
        <div class="grid gap-2 sm:grid-cols-3">
          <div><label for="sort">Sort by</label>
            <select id="sort" name="sort"><option value="">Creation order</option>{#each sortable as field (field)}<option value={carry(field)} selected={field===data.sort?.field}>{shown(field)}</option>{/each}</select></div>
          <div><label for="dir">Direction</label>
            <select id="dir" name="dir"><option value="asc">Ascending</option><option value="desc" selected={data.sort?.direction==='desc'}>Descending</option></select></div>
          <div><label for="limit">Page size (1–100)</label>
            <input id="limit" name="limit" type="number" min="1" max="100" value={data.limit} aria-invalid={data.limitInvalid ? 'true' : undefined} aria-describedby={data.limitInvalid ? 'limit-error' : undefined} />
            {#if data.limitInvalid}<p id="limit-error" class="mt-1 text-sm text-danger">Page size must be 1–100; showing {data.limit}.</p>{/if}</div>
        </div>
        <div class="flex gap-2"><button class="btn">Apply</button><a class="btn-quiet" href={base}>Reset</a></div>
      </form>
      <h2 id="results" class="font-semibold">Results{data.count===null ? '' : ` · ${data.count} matching`}</h2>
      <Notice error={data.error} title="Records could not be read">
        <Restart paged={data.paged} error={data.error} href="{base}?{query}" />
      </Notice>
      {#if data.page}
        {#if data.page.records.length}
          <Scroll label="Records"><table>
            <caption class="sr-only">Records on this page</caption>
            <thead><tr><th scope="col">Record</th><th scope="col">Revision</th>{#each columns as column (column)}<th scope="col" class="ident">{shown(column)}</th>{/each}</tr></thead>
            <tbody>{#each data.page.records as record (record.ref.id)}<tr>
              <td><a class="ident link" href="{base}/records/{segment(record.ref.id)}">{record.keyMode==='external' ? shown(record.normalizedKey) : record.ref.id}</a></td>
              <td>{record.revision}</td>{#each columns as column (column)}<td class="max-w-48 truncate">{cell(record,column)}</td>{/each}
            </tr>{/each}</tbody>
          </table></Scroll>
        {:else}
          <p class="panel hint">{data.rows.length ? 'No records match these filters.' : 'No records yet. Create one or ingest a batch.'}</p>
        {/if}
        <nav aria-label="Record pages" class="flex gap-3">
          {#if data.cursor}<a class="link" href="{base}?{query}">First page</a>{/if}
          {#if next}<a class="link" href={next}>Next page</a>{/if}
        </nav>
        <p class="hint">Pages are exact when read but follow live data: records changed between pages can move.</p>
      {/if}
    </section>
    {@render create()}
  </div>
{:else if form?.create || form?.created || form?.draft}
  <!-- A submitted create keeps its draft, error and request key when the reload fails. -->
  <div class="mt-4 max-w-xl">{@render create()}</div>
{/if}

{#snippet create()}
  <section aria-labelledby="create" class="panel h-fit space-y-3">
    <h2 id="create" class="font-semibold">Create a record</h2>
    <Notice error={form?.create?.error} title={form?.create?.retried ? 'The earlier create is still unresolved' : 'Record was not created'} />
    {#if form?.created}<p role="status" class="text-sm text-success">Created <a class="ident link" href="{base}/records/{segment(form.created.ref.id)}">{form.created.ref.id}</a> at revision {form.created.revision}{form.created.replayed ? ' (recovered earlier result)' : ''}. Search projection: {form.created.projection.state}.</p>{/if}
    <form method="POST" action="?/create" class="space-y-3">
      <input type="hidden" name="idempotencyKey" value={data.idempotencyKey} />
      <Unresolved writes={unresolved} kind="create" />
      <div><label for="externalKey">External key (optional)</label><input id="externalKey" name="externalKey" value={draft?.externalKey ?? ''} /></div>
      <div><label for="data">Data JSON</label>
        <textarea id="data" name="data" rows="8" spellcheck="false" aria-invalid={schemaInvalid ? 'true' : undefined}
          aria-describedby={schemaInvalid ? 'data-error' : undefined}>{draft?.raw ?? '{}'}</textarea>
        {#if schemaInvalid}<p id="data-error" class="mt-1 text-sm text-danger">{form?.create?.invalid ? 'Data must be one JSON object with finite numbers.' : 'The data does not satisfy the collection schema. Correct it and create again.'}</p>{/if}</div>
      <div class="flex flex-wrap gap-2">{#if !unresolved.length}<button class="btn">Create record</button>
        {:else if unresolved.length<maxUnresolved}<button class="btn-quiet" aria-describedby="create-pending-why">Send as new request</button>
        {:else}<p class="hint">Retry or forget an earlier create before sending another.</p>{/if}</div>
    </form>
  </section>
{/snippet}
