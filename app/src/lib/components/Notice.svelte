<script lang="ts">
  import type { ApiError } from '$lib/errors';
  import { describe } from '$lib/errors';
  import { page } from '$app/state';
  let { error, title='Request failed', hint, children }:{ error?:ApiError|null; title?:string; hint?:string; children?:import('svelte').Snippet } = $props();
  let box=$state<HTMLElement>();
  // Move focus to a new failure so keyboard and screen reader users hear it after a full-page submit.
  $effect(() => { if (error) box?.focus(); });
</script>

{#if error}
  <div bind:this={box} tabindex="-1" role="alert" class="rounded-lg border border-danger bg-surface p-3 text-sm">
    <p class="font-semibold text-danger">{title}: <code>{error.code}</code></p>
    <p class="mt-1">{hint ?? describe(error.code)}</p>
    {#if error.code==='UNAUTHENTICATED' && page.url.pathname!=='/'}<p class="mt-1"><a class="link" href="/">Sign in again</a></p>{/if}
    {@render children?.()}
    {#if error.requestId}<p class="hint mt-1">Request ID <code>{error.requestId}</code></p>{/if}
  </div>
{/if}
