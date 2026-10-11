<script lang="ts">
  import { page } from '$app/state';
  let { data, children } = $props();
  const base=$derived(`/spaces/${encodeURIComponent(data.spaceId)}`);
  const links=$derived([{href:base,label:'Collections'},{href:`${base}/access`,label:'Agent access'},{href:`${base}/audit`,label:'Audit'}]);
</script>

<div class="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
  <div class="min-w-0">
    <p class="hint"><a class="link" href="/spaces">Spaces</a> / space</p>
    <p class="break-all font-mono text-sm">{data.spaceId}</p>
  </div>
  {#if data.switchable.length}
    <form method="POST" action="/spaces?/open" class="flex items-end gap-2">
      <div><label for="switch">Switch space</label>
        <select id="switch" name="spaceId">{#each data.switchable as item (item.spaceId)}<option value={item.spaceId} selected={item.spaceId===data.spaceId}>{item.spaceId}</option>{/each}</select></div>
      <button class="btn-quiet">Switch</button>
    </form>
  {/if}
</div>
{#if data.space}
  <nav aria-label="Space sections" class="mb-4 flex flex-wrap gap-4">
    {#each links as link (link.href)}<a class="link" href={link.href} aria-current={page.url.pathname===link.href ? 'page' : undefined}>{link.label}</a>{/each}
  </nav>
{/if}
{@render children()}
