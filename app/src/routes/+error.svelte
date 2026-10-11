<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">{page.status}</h1>
<p class="hint mt-1">{page.error?.message}</p>
