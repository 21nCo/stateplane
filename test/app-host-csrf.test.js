import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The deployed app host is the built SvelteKit server, whose cross-site form
// check only runs outside development, so vite dev cannot show it. This builds
// the app and sends requests to the built server. Without host bindings /v1
// answers 503 PROVIDER_UNAVAILABLE, which shows the request reached its handler.
const app=resolve(import.meta.dirname,'../app');
const origin='https://app.example';
let server;

before(async ()=>{
  const built=spawnSync(process.execPath,[join(app,'node_modules/vite/bin/vite.js'),'build'],{cwd:app,encoding:'utf8',timeout:180_000});
  assert.equal(built.status,0,built.stderr || built.stdout);
  const output=pathToFileURL(join(app,'.svelte-kit/output/server/')).href;
  const { Server }=await import(`${output}index.js`);
  const { manifest }=await import(`${output}manifest.js`);
  server=new Server(manifest);
  await server.init({ env:{} });
},{ timeout:200_000 });

// A request without a type has no body, since a string body would get text/plain.
const send=async (path,{ method='POST',type,from,site,body=type ? 'a=1' : null }={})=>{
  const headers={ ...(type ? { 'content-type':type } : {}), ...(from===undefined ? {} : { origin:from }),
    ...(site ? { 'sec-fetch-site':site } : {}) };
  const response=await server.respond(new Request(origin+path,{ method,headers,body }),
    { getClientAddress:()=>'127.0.0.1',platform:{ env:{} } });
  return { status:response.status,text:await response.text(),location:response.headers.get('location') };
};
// undefined sends no Content-Type, as a bodyless no-cors fetch does.
const forms=[undefined,'text/plain','text/plain;charset=utf-8','multipart/form-data; boundary=x','application/x-www-form-urlencoded','Application/X-SvelteKit-FormData'];
const redirect=({ status,location })=>({ status,location });
const forbidden=/^Cross-site (POST|PUT|PATCH|DELETE) form submissions are forbidden$/;

test('a raw /v1 upload of any form MIME type reaches the bearer-only API handler however its Origin is set', async ()=>{
  for (const path of ['/v1/spaces/s1/collections/c1/uploads/g1/attempts','/%761/spaces/s1/collections/c1/uploads/g1/attempts'])
    for (const type of forms)
      for (const from of [undefined,'null','https://elsewhere.example']) {
        const { status,text }=await send(path,{ type,from });
        assert.equal(status,503,`${path} ${type} ${from}: ${text}`);
        assert.equal(JSON.parse(text).error.code,'PROVIDER_UNAVAILABLE');
      }
  for (const method of ['PUT','PATCH','DELETE'])
    assert.equal((await send('/v1/spaces/s1',{ method,type:'text/plain' })).status,503);
});

test('a cross-site form post to a page action, sign-out or any other route is still refused before it runs', async ()=>{
  for (const path of ['/spaces/s1?/create','/spaces/s1/collections/c1/records/r1?/update','/signout','/','/v1x','/v2/spaces'])
    for (const type of forms)
      for (const from of [undefined,'null','https://elsewhere.example'])
        for (const site of [undefined,'cross-site','same-site']) {
          const { status,text }=await send(path,{ type,from,site });
          assert.equal(status,403,`${path} ${type} ${from} ${site}`);
          assert.match(text,forbidden);
        }
  // The same post from the app's own origin reaches the route; without a
  // session the action answers with its sign-in redirect. Under the pages'
  // no-referrer policy a browser's own form post sends Origin: null with
  // Sec-Fetch-Site: same-origin, and is the app's own post too.
  for (const own of [{ from:origin },{ from:'null',site:'same-origin' },{ site:'same-origin' }]) {
    const action=await send('/spaces/s1?/create',{ type:'application/x-www-form-urlencoded',...own });
    assert.equal(action.status,200,JSON.stringify(own));
    assert.deepEqual(JSON.parse(action.text),{ type:'redirect',status:303,location:'/' });
    for (const type of [undefined,'application/x-www-form-urlencoded'])
      assert.deepEqual(redirect(await send('/signout',{ type,...own })),{ status:303,location:'/' },`${type} ${JSON.stringify(own)}`);
  }
  // A JSON body is not a form submission, so the check leaves it alone, as SvelteKit's did: sign-out runs.
  assert.deepEqual(redirect(await send('/signout',{ type:'application/json',from:'https://elsewhere.example',body:'{}' })),{ status:303,location:'/' });
});
