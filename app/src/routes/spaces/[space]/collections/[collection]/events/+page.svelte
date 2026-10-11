<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import { page } from '$app/state';
  let { data } = $props();
  const base=$derived(`/spaces/${encodeURIComponent(data.spaceId)}/collections/${encodeURIComponent(page.params.collection ?? '')}`);
</script>

<svelte:head><title>Changes · Stateplane</title></svelte:head>
<p class="hint"><a class="link" href={base}>Records</a> / changes</p>
<h1 class="text-2xl font-semibold">Committed changes</h1>
<p class="hint mt-1">Every accepted create, replace, patch and delete with its resulting revision, oldest first.</p>
<Notice error={data.error} title="Changes could not be read" />
{#if data.feed}
  {#if data.feed.events.length}
    <div class="mt-3"><Scroll label="Committed changes"><table>
      <caption class="sr-only">Record revisions</caption>
      <thead><tr><th scope="col">Committed</th><th scope="col">Record</th><th scope="col">Operation</th><th scope="col">Revision</th><th scope="col">Schema</th></tr></thead>
      <tbody>{#each data.feed.events as item (item.eventId)}<tr>
        <td>{new Date(item.committedAt).toISOString()}</td><td><a class="link font-mono" href="{base}/records/{encodeURIComponent(item.recordId)}">{item.recordId}</a></td>
        <td>{item.operation}</td><td>{item.revision}</td><td>v{item.schemaVersion}</td>
      </tr>{/each}</tbody>
    </table></Scroll></div>
  {:else}
    <p class="panel mt-3 hint">No further committed changes yet. Later writes appear from this position.</p>
  {/if}
  <nav aria-label="Change pages" class="mt-3 flex gap-3">
    {#if data.cursor}<a class="link" href="{base}/events">From the beginning</a>{/if}
    {#if data.feed.nextCursor}<a class="link" href="{base}/events?cursor={encodeURIComponent(data.feed.nextCursor)}">Newer changes</a>{/if}
  </nav>
{/if}
