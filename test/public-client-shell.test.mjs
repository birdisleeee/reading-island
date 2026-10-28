import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {Miniflare,Response as MFResponse} from 'miniflare';
import {publicClient} from '../public-service/client-shell.mjs';
import {initialPolicy} from '../public-service/quota.mjs';
test('public APK shell is selected by client identity without changing account approval or standalone login',async()=>{
 const html=await readFile('public-service/index.html','utf8');
 const base={modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{REGISTRY:{className:'Registry',useSQLite:true},READING_LIBRARY:{className:'HostedReadingLibraryDO',useSQLite:true}},bindings:{INTERNAL_KEY:'fixture',OWNER_KEY:'fixture',SESSION_SECRET:'fixture'}};
 const mf=new Miniflare({...base,scriptPath:'dist/public-worker.mjs',serviceBindings:{ASSETS:async()=>new MFResponse(html,{headers:{'Content-Type':'text/html'}})}});
 try{
  const origin='https://reading.test';
  for(const [ua,android,updates] of [['Desktop Chrome',false,false],['Android; wv',true,false],['Android; wv ReadingIslandAndroid/2',true,false],['Android; wv ReadingIslandAndroid/3',true,true]]){
   assert.deepEqual(publicClient(ua),{android,updates});const response=await mf.dispatchFetch(origin+'/app',{headers:{'User-Agent':ua}});assert.equal(response.status,200);assert.equal(response.headers.get('vary'),'User-Agent');const body=await response.text();assert.equal(body.includes('class="client-android"'),android);assert.equal(body.includes('data-native-updates="true"'),updates);
  }
  const login=await mf.dispatchFetch(origin+'/service/api/owner-login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"key":"fixture"}'});const cookie=login.headers.get('set-cookie').split(';')[0];await mf.dispatchFetch(origin+'/service/api/owner/policy',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(initialPolicy)});
  assert.equal((await mf.dispatchFetch(origin+'/api/reading/books',{headers:{'User-Agent':'ReadingIslandAndroid/3'}})).status,401,'APK presentation does not grant book access');
 }finally{await mf.dispose();}
 const single=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings:{READER_TOKEN:'fixture-password',SESSION_SECRET:'fixture'}});
 try{const response=await single.dispatchFetch('https://own.test/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"fixture-password"}'});assert.equal(response.status,200);assert(!JSON.stringify(await response.json()).includes('pending'));}finally{await single.dispose();}
});
