<script lang="ts">
  // Each unresolved write travels with its form as its key, exact request and
  // signed first-send time. Its Retry unchanged comes before the form's other
  // buttons, so Enter cannot send a duplicate; an expired one is disabled, so Enter
  // sends nothing. A form that only carries the writes renders their hidden fields.
  interface Write { key:string; sent:string; at:string; seal:string; deadline:string|null; expired:boolean }
  let { writes, kind, controls=true }:{ writes:Write[]; kind:'create'|'save'; controls?:boolean } = $props();
  const id=$derived(`${kind}-pending`);
  // The server's ISO time, shown the same on the server and in the browser.
  const utc=(iso:string)=>`${iso.slice(0,16).replace('T',' ')} UTC`;
</script>

{#snippet carried(write:Write)}
  <input type="hidden" name="pendingKey" value={write.key} /><input type="hidden" name="pendingSent" value={write.sent} />
  <input type="hidden" name="pendingAt" value={write.at} /><input type="hidden" name="pendingSeal" value={write.seal} />
{/snippet}

{#if !controls}
  {#each writes as write, index (index)}{@render carried(write)}{/each}
{:else if writes.length}
  <div id={id} class="rounded-lg border border-warning p-3 text-sm">
    <p class="font-semibold">{writes.length===1 ? `An earlier ${kind} may have committed` : `${writes.length} earlier ${kind}s may have committed`}</p>
    <p id="{id}-why" class="mt-1">The outcome is unknown. Until a request's retry window closes, Retry unchanged resends that exact request under its key, which recovers its result instead of writing twice. After the window closes its key may no longer recover it, so the retry is not offered. Forget stops tracking a request; it may still have committed. {kind==='create' ?
      'Send as new request creates the draft below as another record, even if an earlier one was created.' :
      'Send as new request saves the editor\'s text instead; if a revision was saved meanwhile, it is shown for comparison before anything is overwritten.'}</p>
    <p class="mt-1">Only this page tracks them: leaving or reloading it{kind==='create' ? ', or changing its filters or records page,' : ''} stops tracking them.</p>
    <ol class="mt-2 space-y-2">
      {#each writes as write, index (index)}
        <li>
          {@render carried(write)}
          <pre id="{id}-{index}" class="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{write.sent}</pre>
          <p id="{id}-{index}-when" class="mt-1 {write.expired ? 'text-danger' : 'hint'}">{#if !write.expired && write.deadline}Its retry window closes at <time datetime={write.deadline}>{utc(write.deadline)}</time>.{:else}{write.deadline ? `Its retry window closed at ${utc(write.deadline)}` : 'Its retry window cannot be confirmed'}, so a retry could {kind==='create' ? 'create it again' : 'no longer recover it'}. {kind==='create' ? 'Check the records list for it' : 'Check the current revision'}, then forget it.{/if}</p>
          <div class="mt-1 flex flex-wrap gap-2">
            <button class="btn" name="retry" value={index} disabled={write.expired} aria-describedby="{id}-why {id}-{index} {id}-{index}-when">Retry unchanged</button>
            <button class="btn-quiet" name="forget" value={index} aria-describedby="{id}-{index} {id}-{index}-when">Forget this request</button>
          </div>
        </li>
      {/each}
    </ol>
  </div>
{/if}
