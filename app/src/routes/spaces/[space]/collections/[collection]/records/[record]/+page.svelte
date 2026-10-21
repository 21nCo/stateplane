<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Status from '$lib/components/Status.svelte';
  import Unresolved from '$lib/components/Unresolved.svelte';
  import { maxUnresolved } from '$lib/errors';
  import { page } from '$app/state';
  import { collectionHref, selectors, shown } from '$lib/paths';
  let { data, form } = $props();
  const base=$derived(collectionHref(data.spaceId,selectors(page.url).collection));
  // After a conflict the user's draft stays in the editor until they choose how to resolve it;
  // the form's revision travels only with that draft, never with the displayed record.
  const draft=$derived(form?.raw ?? data.record?.pretty ?? '');
  // A submitted draft, its error and its retry render without the live read: a
  // concurrent delete or a lost acknowledgement must not hide them.
  // In an edit conflict the editor holds the draft and saves it at the current
  // revision, so Apply sends exactly the text the owner sees there.
  const current=$derived(form?.conflict?.revision ?? null);
  const applyTo=$derived(form?.deleting ? null : current);
  // Unresolved saves stay on the page, whatever later drafts or a delete return, and
  // the editor that carries them renders even when the record cannot be read.
  const unresolved=$derived(form?.pending ?? []);
  const editing=$derived(!!data.record || unresolved.length>0 || (form?.raw!==undefined && (!form?.conflict || applyTo!==null)));
  const retryDelete=$derived(!!form?.deleteError);
  const schemaInvalid=$derived(form?.invalid || form?.error?.code==='SCHEMA_INVALID');
  const tone=(state?:string)=>state==='current' ? 'success' : state==='degraded' ? 'danger' : 'warning';
</script>

<svelte:head><title>Record · Stateplane</title></svelte:head>
<p class="hint"><a class="link" href={base}>Records</a> / record</p>
<Notice error={data.error} title="Record could not be read" />
<h1 class="ident text-xl font-semibold">{data.record?.keyMode==='external' ? shown(data.record.normalizedKey) : shown(selectors(page.url).record)}</h1>
{#if data.record}
  <dl class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
    <div><dt class="inline text-subtle">Record ID</dt> <dd class="ident inline">{data.record.ref.id}</dd></div>
    <div><dt class="inline text-subtle">Revision</dt> <dd class="inline">{data.record.revision}</dd></div>
    <div><dt class="inline text-subtle">Schema version</dt> <dd class="inline">{data.record.schemaVersion}</dd></div>
    <div><dt class="inline text-subtle">Search projection</dt> <dd class="inline">{#if data.projection}<Status tone={tone(data.projection.state)}>{data.projection.state} for revision {data.projection.revision}</Status>{:else}unavailable{/if}</dd></div>
  </dl>
  {#if data.projection?.state!=='current'}<p class="hint mt-1">Search may lag behind this revision; the record shown here is the exact authoritative value.</p>{/if}
{/if}
{#if form?.saved}<p role="status" class="mt-3 text-sm text-success">Saved revision {form.saved.revision} (was {form.saved.beforeRevision}){form.saved.replayed ? ', recovered from an earlier identical request' : ''}. Search projection: {form.saved.projection.state}.</p>{/if}
{#if form?.conflict}
  <section aria-labelledby="conflict" class="mt-4 rounded-lg border border-warning bg-surface p-4" role="alert">
    <h2 id="conflict" class="text-lg font-semibold">Edit conflict</h2>
    {#if form.conflict.deleted}
      <p class="mt-1">This record was deleted, or is no longer visible to this credential, after revision {form.expectedRevision}. Your {form.deleting ? 'deletion' : 'edit'} was not applied.</p>
    {:else if form.conflict.rereadError}
      <p class="mt-1">Revision {form.expectedRevision} is no longer current, and the current record could not be read to compare. Nothing was overwritten.</p>
      <Notice error={form.conflict.rereadError} title="Current record could not be read" />
    {:else}
      <p class="mt-1">You edited revision {form.expectedRevision}, but revision {form.conflict.revision} is now current. Nothing was overwritten. Compare, then keep the current record or apply your version on top of it.</p>
    {/if}
    <div class="mt-3 grid gap-3 md:grid-cols-2">
      <div><h3 class="font-semibold">Your {form.deleting ? 'deletion' : 'edit'} (from revision {form.expectedRevision})</h3><pre class="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{form.deleting ? 'Delete this record' : form.raw}</pre></div>
      {#if form.conflict.pretty!==null}<div><h3 class="font-semibold">Current revision {form.conflict.revision}</h3><pre class="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{form.conflict.pretty}</pre></div>{/if}
    </div>
    {#if form.conflict.revision!==null}
      <div class="mt-3 flex flex-wrap gap-2">
        <a class="btn-quiet" href="?">Keep current revision</a>
        {#if form.deleting}<form method="POST" action="?/delete">
          {@render carryUnresolved()}
          <input type="hidden" name="idempotencyKey" value={data.idempotencyKey} />
          <input type="hidden" name="expectedRevision" value={current} />
          <button class="btn-danger">Delete current revision</button>
        </form>{:else}<button class="btn" form="edit-form">Apply my edit to revision {applyTo}</button>{/if}
      </div>
      {#if !form.deleting}<p class="hint mt-2">Apply saves the text in the editor below, including any changes you make there.</p>{/if}
    {/if}
  </section>
{/if}
{#if editing || retryDelete}
  <div class="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
    {#if editing}
      <section aria-labelledby="edit" class="panel space-y-3">
        <h2 id="edit" class="text-lg font-semibold">Edit data</h2>
        <Notice error={form?.error} title={form?.retried ? 'The earlier save is still unresolved' : 'Record was not saved'} />
        <form id="edit-form" method="POST" action="?/save" class="space-y-3">
          <input type="hidden" name="idempotencyKey" value={data.idempotencyKey} />
          <Unresolved writes={unresolved} kind="save" />
          <input type="hidden" name="expectedRevision" value={applyTo ?? (form?.raw!==undefined ? form.expectedRevision : data.record?.revision ?? form?.expectedRevision)} />
          <label for="data">Data JSON (replaces the whole record)</label>
          <textarea id="data" name="data" rows="14" spellcheck="false" aria-invalid={schemaInvalid ? 'true' : undefined}
            aria-describedby={schemaInvalid ? 'data-error' : undefined}>{draft}</textarea>
          {#if schemaInvalid}<p id="data-error" class="text-sm text-danger">{form?.invalid ? 'Data must be one JSON object with finite numbers.' : 'The data does not satisfy the collection schema. Correct it and save again.'}</p>{/if}
          <div class="flex flex-wrap gap-2">{#if !unresolved.length}<button class="btn">Save revision</button>
            {:else if unresolved.length<maxUnresolved}<button class="btn-quiet" aria-describedby="save-pending-why">Send as new request</button>
            {:else}<p class="hint">Retry or forget an earlier save before sending another.</p>{/if}</div>
        </form>
      </section>
    {/if}
    {#if data.record || retryDelete}
      <section aria-labelledby="remove" class="panel h-fit space-y-3">
        <h2 id="remove" class="text-lg font-semibold">Delete</h2>
        <Notice error={form?.deleteError} title="Record was not deleted">
          {#if form?.deleteError?.code==='COMMIT_OUTCOME_UNKNOWN'}<p class="mt-1">Retry deletion resends the same request. Within the receipt retention window its key recovers the original result; after that a committed deletion shows as deleted instead. Its revision means it never deletes a newer revision.</p>{/if}
        </Notice>
        <p class="hint">Deletion leaves a tombstone; the ID and external key are never reused.</p>
        <form method="POST" action="?/delete">
          {@render carryUnresolved()}
          <input type="hidden" name="idempotencyKey" value={retryDelete ? form?.idempotencyKey : data.idempotencyKey} />
          <input type="hidden" name="expectedRevision" value={retryDelete ? form?.expectedRevision : data.record?.revision} />
          <button class="btn-danger">{retryDelete ? 'Retry deletion of' : 'Delete'} revision {retryDelete ? form?.expectedRevision : data.record?.revision}</button>
        </form>
      </section>
    {/if}
  </div>
{/if}

{#snippet carryUnresolved()}
  <Unresolved writes={unresolved} kind="save" controls={false} />
{/snippet}
