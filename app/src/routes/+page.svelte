<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  let { form } = $props();
</script>

<svelte:head><meta name="description" content="Stateplane owned state spaces" /></svelte:head>
<div class="mx-auto max-w-md space-y-4">
  <h1 class="text-3xl font-semibold">Stateplane</h1>
  <p class="hint">Owned spaces, collections and authoritative records. Sign in with a session bearer to manage your spaces, or with an agent key to use its granted collections.</p>
  <Notice error={form?.error} title="Sign-in failed" />
  <form method="POST" class="panel space-y-3">
    <div>
      <label for="token">Bearer credential</label>
      <input id="token" name="token" type="password" autocomplete="off" required
        aria-invalid={form?.missing ? 'true' : undefined} aria-describedby={form?.missing ? 'token-error' : undefined} />
      {#if form?.missing}<p id="token-error" class="mt-1 text-sm text-danger">Enter a credential.</p>{/if}
    </div>
    <button class="btn">Sign in</button>
  </form>
</div>
