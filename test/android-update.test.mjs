import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';import {Miniflare,Response as MFResponse} from 'miniflare';
import {stageAndroidRelease} from '../tools/stage-android-release.mjs';
import {needsAndroidBootstrap,validAndroidRelease,maybeShowAndroidUpdate} from '../web/android-update-notice.mjs';
import {initialPolicy} from '../public-service/quota.mjs';
const origin='https://reading.nyachu.site',info={schemaVersion:1,packageName:'site.nyachu.reading',versionCode:3,versionName:'1.1.1',minSdk:26,bytes:8,sha256:'a'.repeat(64),signerSha256:'b'.repeat(64),apkUrl:origin+'/download/app.apk?version=3',notes:['更新检查']};
test('APK release staging rejects mismatched artifacts and stages a matching pair',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reading-update-'));try{const apk=join(dir,'fixture.apk'),metadata=join(dir,'info.json'),assets=join(dir,'assets'),bytes=Buffer.from('original fixture');await writeFile(apk,bytes);const valid={...info,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await writeFile(metadata,JSON.stringify(valid));await stageAndroidRelease({apk,metadata,assets});assert.deepEqual(await readFile(join(assets,'download/reading-island.apk')),bytes);
 for(const change of [{bytes:1},{sha256:'c'.repeat(64)},{versionCode:1},{packageName:'other.app'},{apkUrl:'https://evil.test/file.apk'}]){await writeFile(metadata,JSON.stringify({...valid,...change}));await assert.rejects(stageAndroidRelease({apk,metadata,assets}));}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy Android notice is optional, dismissible, same-origin and suppressed on new native clients',async()=>{
 assert(needsAndroidBootstrap('Mozilla Android 12; wv'));assert(!needsAndroidBootstrap('Mozilla Android 12; wv ReadingIslandAndroid/2'));assert(!needsAndroidBootstrap('Desktop Chrome'));
 assert(!validAndroidRelease({...info,apkUrl:'https://evil.test/apk'},origin));
 const {document}=parseHTML('<html><body><form><input value="keep draft"></form></body></html>'),values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const args={userAgent:'Android 12; wv',origin,doc:document,storage,now:100000,fetchImpl:async()=>Response.json(info)};
 await maybeShowAndroidUpdate(args);assert(document.querySelector('aside').textContent.includes('1.1.1'));assert.equal(document.querySelector('aside a').href,info.apkUrl);
 document.querySelector('aside button').onclick();assert(!document.querySelector('aside'));await maybeShowAndroidUpdate(args);assert(!document.querySelector('aside'));assert.equal(document.querySelector('input').value,'keep draft');
 await maybeShowAndroidUpdate({...args,now:100000+86400000});assert(document.querySelector('aside'));document.querySelector('aside').remove();
 await maybeShowAndroidUpdate({...args,fetchImpl:async()=>{throw Error('offline');}});assert(!document.querySelector('aside'));
});
test('public update metadata is no-store and available before account approval without opening book access',async()=>{
 const mf=new Miniflare({modules:true,scriptPath:'dist/public-worker.mjs',compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{REGISTRY:{className:'Registry',useSQLite:true},READING_LIBRARY:{className:'HostedReadingLibraryDO',useSQLite:true}},bindings:{INTERNAL_KEY:'fixture-internal',OWNER_KEY:'fixture-owner',SESSION_SECRET:'fixture-session'},serviceBindings:{ASSETS:async r=>new URL(r.url).pathname==='/download/android-update.json'?MFResponse.json(info):new MFResponse('missing',{status:404})}});
 try{const get=await mf.dispatchFetch(origin+'/download/android-update.json');assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');assert.equal((await get.json()).versionCode,3);assert.equal((await mf.dispatchFetch(origin+'/download/android-update.json',{method:'HEAD'})).status,200);assert.equal((await mf.dispatchFetch(origin+'/download/android-update.json',{method:'POST'})).status,405);
 const login=await mf.dispatchFetch(origin+'/service/api/owner-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'fixture-owner'})});const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await mf.dispatchFetch(origin+'/service/api/owner/policy',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(initialPolicy)})).status,200);assert.equal((await mf.dispatchFetch(origin+'/api/reading/books')).status,401);}finally{await mf.dispose();}
});
