/** One API selector as a URL path segment. A browser drops "." and ".." segments,
 * so dot-only selectors use the API's ;. marker, as the CLI does. */
export const segment=(value:string)=>value==='.' || value==='..' ? `;${value}` : encodeURIComponent(value);
const decode=(part='')=>part===';.' || part===';..' ? part.slice(1) : decodeURIComponent(part);

/** Read selectors from the raw path. SvelteKit params decode %3B. and ;. alike,
 * which would make a collection named ";." indistinguishable from ".". */
export function selectors(url:URL):{space:string;collection:string;record:string} {
  const [, , space, , collection, , record]=url.pathname.split('/');
  return {space:decode(space),collection:decode(collection),record:decode(record)};
}
export const spaceHref=(space:string)=>`/spaces/${segment(space)}`;
export const collectionHref=(space:string,collection:string)=>`${spaceHref(space)}/collections/${segment(collection)}`;
