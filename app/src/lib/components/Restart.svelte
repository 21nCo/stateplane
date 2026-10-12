<script lang="ts">
  import type { ApiError } from '$lib/errors';
  // Every listing shares one rule: a failed page whose request carried a cursor,
  // or whose cursor was rejected, offers the first page. It follows the request,
  // never the cursor value a loader normalized.
  let { paged, error, href, label='Start again from the first page' }:{ paged:boolean; error?:ApiError|null; href:string; label?:string } = $props();
</script>

{#if error && (paged || error.code==='CURSOR_INVALID')}<p class="mt-1"><a class="link" {href}>{label}</a></p>{/if}
