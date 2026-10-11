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
/** Display an identifier; selectors stay exact. A value with surrounding
 * whitespace, a leading quote or any non-printing character (Cc, Cf, Zl, Zp, or
 * Zs other than U+0020, or a default-ignorable character) is shown as a JSON string, with each such character
 * written as a \u escape. Only quoted displays begin with a quote, and JSON
 * escapes quotes and backslashes, so two identifiers never display alike. */
const hidden=/(?! )[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/u;
const escape=(char:string)=>{ const code=char.codePointAt(0)!.toString(16);
  return code.length>4 ? `\\u{${code}}` : `\\u${code.padStart(4,'0')}`; };
export const shown=(id:string)=>id===id.trim() && !id.startsWith('"') && !hidden.test(id) ? id :
  JSON.stringify(id).replace(new RegExp(hidden.source,'gu'),escape);
/** Carry an identifier taken from a listing in a form control or query. Browsers
 * rewrite CR and LF in submitted form data, so they travel escaped, with "%";
 * carriedId() reverses exactly those escapes once. Typed free text is never carried. */
export const carry=(id:string)=>id.replace(/[%\r\n]/g,encodeURIComponent);
export const carriedId=(value:string)=>value.replace(/%(25|0D|0A)/g,decodeURIComponent);
export const spaceHref=(space:string)=>`/spaces/${segment(space)}`;
export const collectionHref=(space:string,collection:string)=>`${spaceHref(space)}/collections/${segment(collection)}`;
