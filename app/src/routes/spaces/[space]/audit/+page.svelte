<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Restart from '$lib/components/Restart.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  let { data } = $props();
</script>

<svelte:head><title>Audit · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Audit</h1>
<p class="hint mt-1">Immutable space administration events, oldest first: creation, lifecycle, key issuance and revocation.</p>
<Notice error={data.error} title="Audit could not be read">
  <Restart paged={data.paged} error={data.error} href="?" />
</Notice>
{#if data.audit}
  {#if data.audit.entries.length}
    <div class="mt-3"><Scroll label="Audit entries"><table>
      <caption class="sr-only">Space audit entries</caption>
      <thead><tr><th scope="col">Recorded</th><th scope="col">Action</th><th scope="col">Credential</th><th scope="col">Policy</th><th scope="col">Placement</th></tr></thead>
      <tbody>{#each data.audit.entries as entry (entry.audit_id)}<tr>
        <td>{new Date(entry.recorded_at).toISOString()}</td><td class="font-mono">{entry.action}</td>
        <td class="ident">{entry.credential_id ?? '—'}</td><td>v{entry.policy_version}</td><td>g{entry.placement_generation}</td>
      </tr>{/each}</tbody>
    </table></Scroll></div>
  {:else}<p class="panel mt-3 hint">No audit entries on this page.</p>{/if}
  <nav aria-label="Audit pages" class="mt-3 flex gap-3">
    {#if data.cursor}<a class="link" href="?">First page</a>{/if}
    {#if data.audit.nextCursor}<a class="link" href="?cursor={encodeURIComponent(data.audit.nextCursor)}">Next page</a>{/if}
  </nav>
{/if}
