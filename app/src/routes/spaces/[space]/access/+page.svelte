<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import Scroll from '$lib/components/Scroll.svelte';
  import Status from '$lib/components/Status.svelte';
  import { shown } from '$lib/paths';
  let { data, form } = $props();
  const capabilities=['records:read','records:write','events:read','schema:write','space:admin'];
  const rows=$derived([...data.collections,'']);
  const tone=(status:string)=>status==='active' ? 'success' : status==='revoked' ? 'danger' : 'warning';
</script>

<svelte:head><title>Agent access · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Agent access</h1>
<p class="hint mt-1">Agent keys act only through the collection capabilities granted here. Revocation takes effect on the next request.</p>
{#if form?.issued}
  <section aria-labelledby="issued" class="mt-4 rounded-lg border border-success bg-surface p-4" role="alert">
    <h2 id="issued" class="font-semibold">Key {form.issued.keyId} issued</h2>
    <p class="mt-1 text-sm">Copy the secret now. It is shown only in this response and cannot be retrieved later.</p>
    <label for="secret" class="mt-2 block">Secret</label>
    <input id="secret" readonly value={form.issued.secret} class="font-mono" />
    <p class="hint mt-1">Expires {form.issued.expiresAt}.</p>
  </section>
{/if}
<div class="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
  <section aria-labelledby="keys" class="min-w-0 space-y-3">
    <h2 id="keys" class="text-lg font-semibold">Keys</h2>
    <Notice error={data.error} title="Keys could not be listed" />
    <Notice error={form?.revokeError} title="Revocation did not finish">
      <p class="mt-1">If the key now shows provider cleanup pending, the API already denies it. Retry to finish revoking it at the provider.</p>
    </Notice>
    {#if form?.revoked}<p role="status" class="text-sm text-success">Key {form.revoked} revoked.</p>{/if}
    {#if data.keys}
      {#if data.keys.items.length}
        <Scroll label="Agent keys"><table>
          <caption class="sr-only">Agent keys and grants</caption>
          <thead><tr><th scope="col">Key</th><th scope="col">Status</th><th scope="col">Grants</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>{#each data.keys.items as key (key.keyId)}<tr>
            <td class="break-all font-mono">{key.keyId}</td><td><Status tone={tone(key.status)}>{key.status}</Status>
              {#if key.revokedAt}<div class="hint">{key.providerRevokedAt ? 'Provider key revoked' : 'Denied here; provider cleanup pending'}</div>{/if}</td>
            <td>{#each key.grants as grant (grant.collectionId)}<div><span class="font-mono">{shown(grant.collectionId)}</span>: {grant.capabilities.join(', ')}</div>{:else}<span class="hint">none</span>{/each}</td>
            <td>{key.expiresAt}</td>
            <td>{#if !key.revokedAt || !key.providerRevokedAt}<form method="POST" action="?/revoke"><input type="hidden" name="keyId" value={key.keyId} />
              <button class="btn-danger" aria-label="{key.revokedAt ? 'Retry provider revocation for' : 'Revoke'} {key.keyId}">{key.revokedAt ? 'Retry revocation' : 'Revoke'}</button></form>{/if}</td>
          </tr>{/each}</tbody>
        </table></Scroll>
      {:else}<p class="panel hint">No agent keys have been issued for this space.</p>{/if}
      <nav aria-label="Key pages" class="flex gap-3">
        {#if data.cursor}<a class="link" href="?">First page</a>{/if}
        {#if data.keys.nextCursor}<a class="link" href="?cursor={encodeURIComponent(data.keys.nextCursor)}">Next page</a>{/if}
      </nav>
    {/if}
  </section>
  <div class="space-y-6">
    <section aria-labelledby="issue" class="panel space-y-3">
      <h2 id="issue" class="text-lg font-semibold">Issue a key</h2>
      <Notice error={form?.issueError} title="Key was not issued">
        {#if form?.issueError?.code==='COMMIT_OUTCOME_UNKNOWN'}<p class="mt-1">The key may exist. Check the key list and revoke any key you cannot account for before issuing another.</p>{/if}
      </Notice>
      <Notice error={data.collectionsError} title="Collections could not all be listed">
        <p class="mt-1">Reload to list them again, or name a collection in the last group.</p>
      </Notice>
      {#if form?.issueInvalid}<p role="alert" class="text-sm text-danger">Choose a lifetime and at least one capability for a named collection.</p>{/if}
      <form method="POST" action="?/issue" class="space-y-3">
        <div><label for="days">Lifetime</label>
          <select id="days" name="days">{#each [1,7,30,90] as days (days)}<option value={days} selected={days===30}>{days} {days===1 ? 'day' : 'days'}</option>{/each}</select></div>
        {#each rows as slug, index (index)}
          <fieldset class="space-y-1 rounded border border-line p-2">
            <legend class="px-1 text-sm font-medium">{slug ? `Collection ${shown(slug)}` : 'Another collection'}</legend>
            {#if slug}<input type="hidden" name="collection" value={slug} />{:else}
              <label for="other-collection">Collection name</label><input id="other-collection" name="collection" />{/if}
            {#each capabilities as capability (capability)}
              <label class="flex items-center gap-2 font-normal"><input type="checkbox" name="capabilities-{index}" value={capability} /> {capability}</label>
            {/each}
          </fieldset>
        {/each}
        {#if data.moreCollections}<p class="hint">Only the first 96 collections are listed; name others in the last group.</p>{/if}
        <button class="btn">Issue key</button>
      </form>
    </section>
    <section aria-labelledby="check" class="panel space-y-3">
      <h2 id="check" class="text-lg font-semibold">Check a key</h2>
      <p class="hint">Confirm whether the provider still authenticates a key secret and whether this space still authorizes it to discover collections, for example after revocation.</p>
      {#if form?.check}<div role="status" class="space-y-1 text-sm">
        <p class={form.check.kind ? 'text-success' : form.check.rejected ? 'text-danger' : 'text-warning'}>Provider: {form.check.kind ? `accepted as ${form.check.kind}` :
          `${form.check.rejected ? 'rejected' : 'not determined'} (${form.check.code})`}.</p>
        {#if !form.check.kind && !form.check.rejected}<p class="hint">This does not confirm revocation. Check again when the provider is reachable.</p>{/if}
        {#if form.check.space}<p class={form.check.space.allowed ? 'text-success' : 'text-danger'}>This space: {form.check.space.allowed ? 'allowed' :
          `${form.check.space.denied ? 'denied' : 'not determined'} (${form.check.space.code})`}.</p>
          {#if form.check.space.denied}<p class="hint">The provider still accepts this key. If it shows provider cleanup pending, retry its revocation.</p>{/if}{/if}
      </div>{/if}
      <form method="POST" action="?/check" class="space-y-3">
        <label for="check-secret">Key secret</label>
        <input id="check-secret" name="secret" type="password" autocomplete="off" required aria-invalid={form?.checkMissing ? 'true' : undefined}
          aria-describedby={form?.checkMissing ? 'check-error' : undefined} />
        {#if form?.checkMissing}<p id="check-error" class="text-sm text-danger">Enter a key secret.</p>{/if}
        <button class="btn-quiet">Check key</button>
      </form>
    </section>
  </div>
</div>
