<script lang="ts">
  // Each unresolved write travels with its form as its key and exact request. Its
  // Retry unchanged comes before the form's other buttons, so Enter cannot send a
  // duplicate. A form that only carries the writes renders their hidden fields.
  let { writes, kind, controls=true }:{ writes:{key:string;sent:string}[]; kind:'create'|'save'; controls?:boolean } = $props();
  const id=$derived(`${kind}-pending`);
</script>

{#if !controls}
  {#each writes as write, index (index)}<input type="hidden" name="pendingKey" value={write.key} /><input type="hidden" name="pendingSent" value={write.sent} />{/each}
{:else if writes.length}
  <div id={id} class="rounded-lg border border-warning p-3 text-sm">
    <p class="font-semibold">{writes.length===1 ? `An earlier ${kind} may have committed` : `${writes.length} earlier ${kind}s may have committed`}</p>
    <p class="mt-1">The outcome is unknown. Retry unchanged resends that exact request under its key, which recovers its result instead of writing twice. Forget stops offering the retry; the request may still have committed. {kind==='create' ?
      'Send as new request creates the draft below as another record, even if an earlier one was created.' :
      'Send as new request saves the editor\'s text instead; if a revision was saved meanwhile, it is shown for comparison before anything is overwritten.'}</p>
    <ol class="mt-2 space-y-2">
      {#each writes as write, index (index)}
        <li>
          <input type="hidden" name="pendingKey" value={write.key} /><input type="hidden" name="pendingSent" value={write.sent} />
          <pre id="{id}-{index}" class="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{write.sent}</pre>
          <div class="mt-1 flex flex-wrap gap-2">
            <button class="btn" name="retry" value={index} aria-describedby="{id} {id}-{index}">Retry unchanged</button>
            <button class="btn-quiet" name="forget" value={index} aria-describedby="{id}-{index}">Forget this request</button>
          </div>
        </li>
      {/each}
    </ol>
  </div>
{/if}
