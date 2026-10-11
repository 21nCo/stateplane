<script lang="ts">
  import Notice from '$lib/components/Notice.svelte';
  import type { ApiError } from '$lib/errors';
  let { action, definition, invalid=false, error, submit, children }:{ action:string; definition:string; invalid?:boolean;
    error?:ApiError|null; submit:string; children?:import('svelte').Snippet } = $props();
</script>

<Notice {error} title="Definition was not saved" />
<form method="POST" {action} class="space-y-3">
  {@render children?.()}
  <div>
    <label for="definition">Definition JSON</label>
    <textarea id="definition" name="definition" rows="18" spellcheck="false" aria-describedby="definition-hint{invalid ? ' definition-error' : ''}"
      aria-invalid={invalid ? 'true' : undefined}>{definition}</textarea>
    {#if invalid}<p id="definition-error" class="mt-1 text-sm text-danger">The definition must be one JSON object.</p>{/if}
    <p id="definition-hint" class="hint mt-1">A closed Draft 2020-12 object schema plus <code>unique</code>, <code>filterable</code> and <code>sortable</code> field lists. Revisions may add optional fields and index declarations; existing constraints cannot change.</p>
  </div>
  <button class="btn">{submit}</button>
</form>
