<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import Status from '$lib/components/Status.svelte';
  import { page } from '$app/state';
  import { carry, collectionHref, segment, selectors } from '$lib/paths';
  import { uncertain as isUncertain } from '$lib/errors';
  let { data, form } = $props();
  const base=$derived(collectionHref(data.spaceId,selectors(page.url).collection));
  // A submitted batch shows its own progress beside its retained lines; a refused cancel
  // stays on its operation (the key rides on the action URL) and rereads its progress.
  const progress=$derived(form?.progress ?? data.progress);
  // Without its retained lines (also after a cancel), an operation key is never paired with other lines.
  const resuming=$derived(form?.items===undefined && !!data.operation);
  const counts=$derived((progress?.items ?? []).reduce<Record<string,number>>((all,item)=>({...all,[item.state]:(all[item.state] ?? 0)+1}),{}));
  const tone=(state:string)=>state==='succeeded' ? 'success' : state==='failed' ? 'danger' : 'warning';
  const uncertain=$derived(isUncertain(form?.error));
</script>

<svelte:head><title>Ingestion · Stateplane</title></svelte:head>
<p class="hint"><a class="link" href={base}>Records</a> / ingestion</p>
<h1 class="text-2xl font-semibold">Bulk ingestion</h1>
<div class="mt-4 grid gap-6 lg:grid-cols-2">
  <section aria-labelledby="submit" class="panel space-y-3">
    <h2 id="submit" class="text-lg font-semibold">Submit a batch</h2>
    <Notice error={form?.error} title="Batch was not accepted">
      {#if uncertain}<p class="mt-1">Some items may have committed. <a class="link" href="?operation={encodeURIComponent(form?.operationKey ?? '')}">Read this operation's progress</a>, then resubmit the same key and unchanged lines to resume pending items.</p>{/if}
    </Notice>
    <form method="POST" action="?/ingest" class="space-y-3">
      <div><label for="operationKey">Operation key</label>
        <input id="operationKey" name="operationKey" required value={form?.operationKey ?? data.operation} aria-invalid={form?.keyMissing ? 'true' : undefined} aria-describedby="key-hint" />
        <p id="key-hint" class="hint mt-1">Reuse a key only with identical lines; it identifies the batch for status and resumption.</p></div>
      <div><label for="items">Record requests, one JSON object per line (1–20)</label>
        <textarea id="items" name="items" rows="8" spellcheck="false" aria-invalid={form?.countInvalid ? 'true' : undefined}
          aria-describedby={form?.countInvalid ? 'items-error' : resuming ? 'items-hint' : undefined}>{form?.items ?? (resuming ? '' : '{"operation":"create","data":{}}')}</textarea>
        {#if resuming}<p id="items-hint" class="hint mt-1">To resume this operation, enter its exact original lines; progress does not include them.</p>{/if}
        {#if form?.countInvalid}<p id="items-error" class="mt-1 text-sm text-danger">Enter between 1 and 20 nonblank lines.</p>{/if}</div>
      <label class="flex items-center gap-2"><input type="checkbox" name="retryFailed" checked={form?.retryFailed} /> Retry failed items</label>
      <button class="btn">Submit batch</button>
    </form>
  </section>
  <section aria-labelledby="progress" class="panel space-y-3">
    <h2 id="progress" class="text-lg font-semibold">Progress</h2>
    <form method="GET" class="flex items-end gap-2">
      <div class="grow"><label for="operation">Operation key</label><input id="operation" name="operation" value={form?.progress ? form.operationKey : data.operation} /></div>
      <button class="btn-quiet">Show progress</button>
    </form>
    {#if !form?.progress}<Notice error={data.error} title="Progress could not be read" />{/if}
    <Notice error={form?.cancelError} title="Remaining items were not cancelled">
      {#if form?.cancelError?.code==='COMMIT_OUTCOME_UNKNOWN'}<p class="mt-1">The cancellation may have taken effect. <a class="link" href="?operation={encodeURIComponent(form.cancelKey ?? '')}">Reread progress</a> before cancelling again.</p>{/if}
    </Notice>
    {#if progress}
      <p class="flex flex-wrap gap-2" role="status">
        <Status tone={progress.state==='active' ? 'neutral' : 'warning'}>{progress.state}</Status>
        {#each Object.entries(counts) as [state,count] (state)}<Status tone={tone(state)}>{count} {state}</Status>{/each}
      </p>
      <Scroll label="Batch items"><table>
        <caption class="sr-only">Items in operation {progress.operationKey}</caption>
        <thead><tr><th scope="col">Line</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Result</th></tr></thead>
        <tbody>{#each progress.items as item (item.ordinal)}<tr>
          <td>{item.ordinal+1}</td><td>{item.state}</td><td>{item.attempts}</td>
          <td>{#if item.receipt}<a class="ident link" href="{base}/records/{segment(item.receipt.ref.id)}">{item.receipt.ref.id}</a> r{item.receipt.revision}{:else if item.failureCode}<code>{item.failureCode}</code>{:else}—{/if}</td>
        </tr>{/each}</tbody>
      </table></Scroll>
      {#if progress.state==='active' && progress.items.some(item=>item.state==='pending')}
        <form method="POST" action="?operation={encodeURIComponent(progress.operationKey)}&/cancel"><input type="hidden" name="operationKey" value={carry(progress.operationKey)} /><button class="btn-danger">Cancel remaining items</button></form>
      {/if}
    {:else if !data.operation}
      <p class="hint">Enter an operation key to see its items.</p>
    {/if}
  </section>
</div>
