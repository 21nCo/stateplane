<script lang="ts">
  import '../app.css';
  let { data, children } = $props();
</script>

<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-surface focus:p-2">Skip to content</a>
<header class="border-b border-line bg-surface">
  <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
    <a href={data.signedIn ? '/spaces' : '/'} class="font-semibold">Stateplane</a>
    {#if data.signedIn}
      <form method="POST" action="/signout"><button class="btn-quiet">Sign out</button></form>
    {/if}
  </div>
</header>
<main id="main" class="mx-auto max-w-6xl px-4 py-6">{@render children()}</main>
