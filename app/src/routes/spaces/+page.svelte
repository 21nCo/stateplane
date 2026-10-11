<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import Status from '$lib/components/Status.svelte';
  import { spaceHref } from '$lib/paths';
  let { data, form } = $props();
  const spaceId=$derived(form?.create?.spaceId ?? data.newSpaceId);
</script>

<svelte:head><title>Spaces · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Spaces</h1>
<div class="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
  <section aria-labelledby="owned" class="space-y-3">
    <h2 id="owned" class="text-lg font-semibold">Your spaces</h2>
    <Notice error={data.error} title="Spaces could not be listed">
      {#if data.error?.code==='FORBIDDEN'}<p class="mt-1">Agent keys cannot list spaces. Open the space you were granted by its ID.</p>{/if}
    </Notice>
    {#if data.page}
      {#if data.page.items.length}
        <Scroll label="Owned spaces"><table>
          <caption class="sr-only">Owned spaces and their placement</caption>
          <thead><tr><th scope="col">Space</th><th scope="col">Lifecycle</th><th scope="col">Home cell</th><th scope="col">Current cell</th><th scope="col">Storage target</th></tr></thead>
          <tbody>{#each data.page.items as space (space.spaceId)}<tr>
            <td><a class="link font-mono" href={spaceHref(space.spaceId)}>{space.spaceId}</a></td>
            <td><Status tone={space.lifecycle==='active' ? 'success' : 'warning'}>{space.lifecycle}</Status></td>
            <td>{space.homeCellId}</td><td>{space.cellId}</td><td>{space.storageTargetId}</td>
          </tr>{/each}</tbody>
        </table></Scroll>
      {:else if data.page.cursor}
        <p class="hint">This page holds only spaces still being provisioned. Continue to the next page.</p>
      {:else}
        <p class="panel hint">No spaces yet. Create one to hold collections and records.</p>
      {/if}
      <nav aria-label="Space pages" class="flex gap-3">
        {#if data.cursor}<a class="link" href="/spaces">First page</a>{/if}
        {#if data.page.cursor}<a class="link" href="/spaces?cursor={encodeURIComponent(data.page.cursor)}">Next page</a>{/if}
      </nav>
    {/if}
  </section>
  <div class="space-y-6">
    <section aria-labelledby="create" class="panel space-y-3">
      <h2 id="create" class="text-lg font-semibold">Create a space</h2>
      <Notice error={form?.create?.error} title="Space was not created">
        {#if form?.create?.error?.code==='COMMIT_OUTCOME_UNKNOWN'}<p class="mt-1">Submit again: the same space ID is reused, so a committed space is recovered rather than duplicated.</p>{/if}
      </Notice>
      <form method="POST" action="?/create" class="space-y-3">
        <input type="hidden" name="spaceId" value={spaceId} />
        <p class="hint">Space ID <code class="break-all">{spaceId}</code></p>
        <div>
          <label for="cellId">Home cell (optional)</label>
          <input id="cellId" name="cellId" value={form?.create?.cellId ?? ''} aria-describedby="cell-hint" />
          <p id="cell-hint" class="hint mt-1">Leave empty for the service default. The service accepts only its configured cells.</p>
        </div>
        <button class="btn">Create space</button>
      </form>
    </section>
    <section aria-labelledby="open" class="panel space-y-3">
      <h2 id="open" class="text-lg font-semibold">Open a space by ID</h2>
      <form method="POST" action="?/open" class="space-y-3">
        <label for="open-id">Space ID</label>
        <input id="open-id" name="spaceId" required aria-invalid={form?.open?.missing ? 'true' : undefined}
          aria-describedby={form?.open?.missing ? 'open-error' : undefined} />
        {#if form?.open?.missing}<p id="open-error" class="text-sm text-danger">Enter a space ID.</p>{/if}
        <button class="btn-quiet">Open</button>
      </form>
    </section>
  </div>
</div>
