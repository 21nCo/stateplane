/** One API selector as a URL path segment. A browser drops "." and ".." segments,
 * so dot-only selectors use the API's ;. marker, as the CLI does. SvelteKit strips
 * the __data.json and __route.js path suffixes, so their first "_" is escaped. */
export const segment=(value:string)=>value==='.' || value==='..' ? `;${value}` :
  encodeURIComponent(value).replace(/_(_data\.json|_route\.js)$/,'%5F$1');
const decode=(part='')=>part===';.' || part===';..' ? part.slice(1) : decodeURIComponent(part);

/** Read selectors from the raw path. SvelteKit params decode %3B. and ;. alike,
 * which would make a collection named ";." indistinguishable from ".". */
export function selectors(url:URL):{space:string;collection:string;record:string} {
  const [, , space, , collection, , record]=url.pathname.split('/');
  return {space:decode(space),collection:decode(collection),record:decode(record)};
}
/** Display an identifier with surrounding whitespace made visible; selectors stay
 * exact. Invisible characters such as U+FEFF are written as \u escapes. */
export const shown=(id:string)=>id===id.trim() ? id : JSON.stringify(id)
  .replace(/[^\x20-\x7e\p{L}\p{M}\p{N}\p{P}\p{S}]/gu,char=>`\\u${char.codePointAt(0)!.toString(16).padStart(4,'0')}`);
export const spaceHref=(space:string)=>`/spaces/${segment(space)}`;
export const collectionHref=(space:string,collection:string)=>`${spaceHref(space)}/collections/${segment(collection)}`;
