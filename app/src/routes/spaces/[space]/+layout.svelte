<script lang="ts">
  import { page } from '$app/state';
  import { carry, shown, spaceHref } from '$lib/paths';
  let { data, children } = $props();
  const base=$derived(spaceHref(data.spaceId));
  const links=$derived([{href:base,label:'Collections'},{href:`${base}/audit`,label:'Audit'}]);
</script>

<div class="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
  <div class="min-w-0">
    <p class="hint"><a class="link" href="/spaces">Spaces</a> / space</p>
    <p class="ident text-sm">{shown(data.spaceId)}</p>
  </div>
  {#if data.switchable.length}
    <form method="POST" action="/spaces?/open" class="flex min-w-0 items-end gap-2">
      <div class="min-w-0"><label for="switch">Switch space</label>
        <select id="switch" name="listed">{#each data.switchable as item (item)}<option value={carry(item)} selected={item===data.spaceId}>{shown(item)}</option>{/each}</select></div>
      <button class="btn-quiet">Switch</button>
      {#if data.moreSpaces}<a class="link text-sm" href="/spaces">More spaces</a>{/if}
    </form>
  {/if}
</div>
{#if data.space}
  <nav aria-label="Space sections" class="mb-4 flex flex-wrap gap-4">
    {#each links as link (link.href)}<a class="link" href={link.href} aria-current={page.url.pathname===link.href ? 'page' : undefined}>{link.label}</a>{/each}
  </nav>
{/if}
{@render children()}
