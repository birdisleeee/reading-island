import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(module,run){
  const keys=['document','window','indexedDB','matchMedia','MutationObserver','requestAnimationFrame'],saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]])),createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL;
  const {document,Event}=parseHTML('<html><body><main id="app" data-view="shelf"><div class="library-hero"><img src="/default-hero.svg"></div><div class="discussion-lead-title"><img src="/default-discussion.svg"></div></main><div id="toast"></div></body></html>');
  const listeners=new Map(),frames=[],created=[],revoked=[],held=[];let record=null,closed=0,holding=false;
  const media={matches:true,addEventListener(){}};
  const create=document.createElement.bind(document);document.createElement=name=>{const element=create(name);if(name==='dialog')element.close=()=>{element.open=false;element.dispatchEvent(new Event('close'));};return element;};
  const database={transaction(){return {objectStore(){return {get(){const request={result:typeof record==='function'?record():record};if(holding)held.push(()=>request.onsuccess());else queueMicrotask(()=>request.onsuccess());return request;}};}};},close(){closed++;}};
  Object.assign(globalThis,{document,window:{addEventListener(type,fn){const callbacks=listeners.get(type)||[];callbacks.push(fn);listeners.set(type,callbacks);}},indexedDB:{open(){const request={result:database};queueMicrotask(()=>request.onsuccess());return request;}},matchMedia:()=>media,MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}});
  URL.createObjectURL=blob=>{const url='blob:fixture-'+(created.length+1);created.push({blob,url});return url;};URL.revokeObjectURL=url=>revoked.push(url);
  const settle=async()=>{for(let i=0;i<3;i++){await flush();while(frames.length)frames.shift()(0);}};
  const image=document.querySelector(module==='desktop'?'.library-hero img':'.discussion-lead-title img');
  try{
    const api={set(value){record=value;},holdReads(){holding=true;},releaseReads(){holding=false;while(held.length)held.shift()();},created,revoked,image,get closed(){return closed;},focus(){for(const fn of listeners.get('focus')||[])fn();},settle};
    await run(api,async()=>{const loaded=await import(`../web/${module}.mjs?focus-test=${module}-${Date.now()}`);await settle();return loaded;});
  }finally{for(const key of keys)if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;}
}

for(const module of ['artwork','desktop'])test(`${module}: focus reuses identical image URLs, replacement and reset revoke only obsolete URLs`,()=>fixture(module,async(h,start)=>{
  const first=new Blob(['first image'],{type:'image/png'}),original=module==='desktop'?'/default-hero.svg':'/default-discussion.svg';
  h.set(()=>({blob:new Blob([first],{type:first.type}),source:first,crop:{scale:1},size:100}));await start();
  const url=h.image.getAttribute('src');assert.equal(h.created.length,1);assert.equal(url,'blob:fixture-1');
  h.set(()=>({blob:new Blob([first],{type:first.type}),source:new Blob(['changed source'],{type:'image/png'}),crop:{scale:2},size:61}));h.focus();await h.settle();
  assert.equal(h.image.getAttribute('src'),url);assert.equal(h.created.length,1);assert.deepEqual(h.revoked,[]);
  if(module==='desktop')assert.equal(h.image.style.getPropertyValue('--hero-size'),'61%','size-only refresh updates the CSS without changing src');
  h.set({blob:new Blob(['other image'],{type:'image/png'}),size:75});h.focus();await h.settle();
  assert.equal(h.image.getAttribute('src'),'blob:fixture-2');assert.equal(h.created.length,2);assert.deepEqual(h.revoked,[url]);
  h.set({size:100});h.focus();await h.settle();assert.equal(h.image.getAttribute('src'),original);assert.deepEqual(h.revoked,[url,'blob:fixture-2']);assert.equal(h.created.length,2);
  h.focus();await h.settle();assert.equal(h.created.length,2);assert.equal(h.revoked.length,2);assert(h.closed>=5);
}));

test('desktop initial artwork readiness waits for the first local read and exposes the loaded custom URL',()=>fixture('desktop',async(h,start)=>{
  h.set({blob:new Blob(['saved custom hero'],{type:'image/png'}),size:64});h.holdReads();
  const module=await start();let ready=false;module.initialDesktopArtwork.then(()=>{ready=true;});await flush();
  assert.equal(ready,false);assert.equal(module.getDesktopArtworkUrl(),'');assert.equal(h.created.length,0);
  h.releaseReads();assert.equal(await module.initialDesktopArtwork,'blob:fixture-1');assert.equal(module.getDesktopArtworkUrl(),'blob:fixture-1');await h.settle();
  assert.equal(h.image.getAttribute('src'),'blob:fixture-1');assert.equal(h.image.style.getPropertyValue('--hero-size'),'64%');
}));

test('desktop initial artwork readiness resolves the default when no saved image exists',()=>fixture('desktop',async(h,start)=>{
  const module=await start();assert.equal(await module.initialDesktopArtwork,'');assert.equal(module.getDesktopArtworkUrl(),'');assert.equal(h.created.length,0);
}));

for(const module of ['artwork','desktop'])test(`${module}: a stale focus comparison cannot replace or revoke the newer image`,()=>fixture(module,async(h,start)=>{
  const first=new Blob(['first image'],{type:'image/png'});h.set({blob:first,size:100});await start();
  const wait=deferred();let started=false;
  class SlowBlob extends Blob{async arrayBuffer(){started=true;return wait.promise;}}
  h.set({blob:new SlowBlob(['first image'],{type:'image/png'}),size:41});h.focus();await h.settle();assert.equal(started,true);
  h.set({blob:new Blob(['later image'],{type:'image/png'}),size:73});h.focus();await h.settle();assert.equal(h.image.getAttribute('src'),'blob:fixture-2');
  wait.resolve(await first.arrayBuffer());await h.settle();assert.equal(h.image.getAttribute('src'),'blob:fixture-2');assert.equal(h.created.length,2);assert.deepEqual(h.revoked,['blob:fixture-1']);
  if(module==='desktop')assert.equal(h.image.style.getPropertyValue('--hero-size'),'73%');
}));
