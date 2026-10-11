<script lang="ts">
  import DefinitionForm from '$lib/components/DefinitionForm.svelte';
  let { form } = $props();
  // A generic starting point; every name is editable.
  const template=JSON.stringify({schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,
    required:['title'],properties:{title:{type:'string',maxLength:200},state:{type:'string',enum:['open','done']},rank:{type:'integer'}}},
    unique:[],filterable:['state','rank'],sortable:['rank']},null,2);
</script>

<svelte:head><title>Define collection · Stateplane</title></svelte:head>
<h1 class="text-2xl font-semibold">Define a collection</h1>
<div class="panel mt-4 max-w-3xl">
  <DefinitionForm action="" definition={form?.definition ?? template} invalid={form?.invalid} error={form?.error} submit="Define collection">
    <div>
      <label for="slug">Collection name</label>
      <input id="slug" name="slug" required value={form?.slug ?? ''} aria-invalid={form?.missingSlug ? 'true' : undefined}
        aria-describedby={form?.missingSlug ? 'slug-error' : undefined} />
      {#if form?.missingSlug}<p id="slug-error" class="mt-1 text-sm text-danger">Enter a collection name.</p>{/if}
    </div>
  </DefinitionForm>
</div>
