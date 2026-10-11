<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import Status from '$lib/components/Status.svelte';
  import { page } from '$app/state';
  let { data, form } = $props();
  const base=$derived(`/spaces/${encodeURIComponent(data.spaceId)}/collections/${encodeURIComponent(page.params.collection ?? '')}`);
  const counts=$derived((data.progress?.items ?? []).reduce<Record<string,number>>((all,item)=>({...all,[item.state]:(all[item.state] ?? 0)+1}),{}));
  const tone=(state:string)=>state==='succeeded' ? 'success' : state==='failed' ? 'danger' : 'warning';
  const uncertain=$derived(['COMMIT_OUTCOME_UNKNOWN','RATE_LIMITED','PROVIDER_UNAVAILABLE'].includes(form?.error?.code ?? ''));
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
          aria-describedby={form?.countInvalid ? 'items-error' : undefined}>{form?.items ?? '{"operation":"create","data":{}}'}</textarea>
        {#if form?.countInvalid}<p id="items-error" class="mt-1 text-sm text-danger">Enter between 1 and 20 nonblank lines.</p>{/if}</div>
      <label class="flex items-center gap-2"><input type="checkbox" name="retryFailed" checked={form?.retryFailed} /> Retry failed items</label>
      <button class="btn">Submit batch</button>
    </form>
  </section>
  <section aria-labelledby="progress" class="panel space-y-3">
    <h2 id="progress" class="text-lg font-semibold">Progress</h2>
    <form method="GET" class="flex items-end gap-2">
      <div class="grow"><label for="operation">Operation key</label><input id="operation" name="operation" value={data.operation} /></div>
      <button class="btn-quiet">Show progress</button>
    </form>
    <Notice error={data.error ?? form?.cancelError} title="Progress could not be read" />
    {#if data.progress}
      <p class="flex flex-wrap gap-2" role="status">
        <Status tone={data.progress.state==='active' ? 'neutral' : 'warning'}>{data.progress.state}</Status>
        {#each Object.entries(counts) as [state,count] (state)}<Status tone={tone(state)}>{count} {state}</Status>{/each}
      </p>
      <Scroll label="Batch items"><table>
        <caption class="sr-only">Items in operation {data.progress.operationKey}</caption>
        <thead><tr><th scope="col">Line</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Result</th></tr></thead>
        <tbody>{#each data.progress.items as item (item.ordinal)}<tr>
          <td>{item.ordinal+1}</td><td>{item.state}</td><td>{item.attempts}</td>
          <td>{#if item.receipt}<a class="link font-mono" href="{base}/records/{encodeURIComponent(item.receipt.ref.id)}">{item.receipt.ref.id}</a> r{item.receipt.revision}{:else if item.failureCode}<code>{item.failureCode}</code>{:else}—{/if}</td>
        </tr>{/each}</tbody>
      </table></Scroll>
      {#if data.progress.state==='active' && data.progress.items.some(item=>item.state==='pending')}
        <form method="POST" action="?/cancel"><input type="hidden" name="operationKey" value={data.progress.operationKey} /><button class="btn-danger">Cancel remaining items</button></form>
      {/if}
    {:else if !data.operation}
      <p class="hint">Enter an operation key to see its items.</p>
    {/if}
  </section>
</div>
