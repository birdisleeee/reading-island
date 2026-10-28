import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,Response as FixtureResponse} from 'miniflare';
import {initialPolicy,suggestedQuota} from '../public-service/quota.mjs';

const bindings={INTERNAL_KEY:'fixture-internal-not-production',OWNER_KEY:'fixture-owner-not-production',SESSION_SECRET:'fixture-session-not-production',PUBLIC_SERVICE:'true',AI_MODE:'mock'};
export const options={modules:true,scriptPath:'dist/public-worker.mjs',compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{REGISTRY:{className:'Registry',useSQLite:true},READING_LIBRARY:{className:'HostedReadingLibraryDO',useSQLite:true}},bindings};
test('a queued background task can record failure and stop after its storage allowance is lowered',async()=>{
 let network=0;const mf=new Miniflare({...options,outboundService:async()=>{network++;return new FixtureResponse('unavailable',{status:503});}});
 try{
  const {req,cookie,owner,user}=await approvedFixture(mf,suggestedQuota);
  const queued=await req('/api/book-catalog/jobs',{job_id:'quota_lowered',type:'search',query:'original'},cookie);assert.equal(queued.status,200);
  const review=await req('/service/api/owner/review',{id:user.id,expectedRevision:1,status:'active',quota:{...suggestedQuota,bytes:512},note:''},owner);assert.equal(review.status,200);
  let job;
  for(let attempt=0;attempt<50;attempt++){const response=await req('/api/book-catalog/jobs',null,cookie);assert.equal(response.status,200);job=(await response.json()).items[0];if(job.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(job.status,'failed');assert.equal(job.error,'storage_quota_exceeded');assert.equal(network,0,'no download or search starts after refreshed storage is exhausted');
 }finally{await mf.dispose();}
});
test('registration accepts a short password and optional notification email without an application purpose',async()=>{
 const mf=new Miniflare(options),origin='https://reading.test';
 let sequence=0;
 const req=(path,body,cookie='')=>mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','CF-Connecting-IP':'registration-fixture-'+sequence++},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const owner=(await req('/service/api/owner-login',{key:bindings.OWNER_KEY})).headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/service/api/owner/policy',initialPolicy,owner)).status,200);
  const payload={username:'shortpass',password:'a',name:'原创读者'};
  for(const patch of [{password:''},{password:'a'.repeat(129)},{email:'not-an-email'},{email:123}])assert.equal((await req('/service/api/register',{...payload,...patch})).status,400);
  let r=await req('/service/api/register',payload);assert.equal(r.status,201,await r.clone().text());
  const user=(await r.json()).user;assert.equal(user.status,'pending');assert.equal(user.quota.books,0);
  r=await req('/service/api/login',{username:payload.username,password:'a'});assert.equal(r.status,200);
  assert.equal((await req('/api/session',null,r.headers.get('set-cookie').split(';')[0])).status,403,'short passwords do not bypass approval');
  r=await req('/service/api/register',{...payload,username:'mailreader',email:' notice@example.test ',reason:'ignored legacy field'});assert.equal(r.status,201);
  const list=await(await req('/service/api/owner/list',null,owner)).json();
  assert.equal(list.users.find(u=>u.username==='mailreader').email,'notice@example.test');
  const noEmail=list.users.find(u=>u.username==='shortpass');assert.equal(noEmail.email,'');assert.equal(noEmail.reason,undefined);
 }finally{await mf.dispose();}
});
test('public applications, manual approval, hard capacity, tenant isolation and all quotas are enforced',async()=>{
 const mf=new Miniflare(options);const origin='https://reading.test';
 const request=(path,body,cookie='',method=body?'POST':'GET')=>mf.dispatchFetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
 const reg=async name=>{const r=await request('/service/api/register',{username:name,password:'fixture-password-123',name:'原创读者',contact:'fiction@example.test',reason:'原创阅读测试'});assert.equal(r.status,201,await r.clone().text());return {cookie:cookie(r),...(await r.json()).user};};
 const review=async(u,quota=suggestedQuota,status='active')=>request('/service/api/owner/review',{id:u.id,expectedRevision:u.revision,status,quota,note:'测试审批'},owner);
 let owner;
 try{
  let r=await request('/service/api/owner-login',{key:bindings.OWNER_KEY});assert.equal(r.status,200);owner=cookie(r);
  assert.equal((await request('/service/api/register',{username:'before'})).status,503);
  assert.equal((await request('/service/api/owner/policy',initialPolicy,owner)).status,200);
  const alice=await reg('alice'),bob=await reg('bobby'),carol=await reg('carol');
  assert.equal((await request('/api/session',null,alice.cookie)).status,403);
  assert.equal((await request('/api/session',null,'reading_session=forged; X-Service-Key=bad')).status,401);
  assert.equal((await request('/api/reading/gateway/reply',{},alice.cookie)).status,404);
  assert.equal((await request('/service/api/owner/list',null,alice.cookie)).status,403);
  const tiny={...suggestedQuota,books:1,threads:1,bytes:32000,aiCalls:2,requestsPerDay:100};
  assert.equal((await review(alice,tiny)).status,200);
  assert.equal((await review(bob)).status,200);assert.equal((await review(carol)).status,200);
  // Registration rate is independently bounded; the fourth fixture uses a different IP.
  r=await mf.dispatchFetch(origin+'/service/api/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'fixture-second-ip'},body:JSON.stringify({username:'david',password:'fixture-password-123',name:'读者四',contact:'fiction@example.test',reason:'容量测试'})});
  const david=(await r.json()).user;assert.ok(david);
  assert.equal((await review(david)).status,400);
  assert.equal((await review(alice,tiny)).status,409,'stale reviews must fail');
  const create=(id,c=alice.cookie)=>request('/api/reading/books',{book_id:id,title:'原创书籍'},c);
  assert.equal((await create('book_one')).status,200);
  assert.equal((await create('book_one')).status,200,'idempotent retry does not consume another book');
  assert.equal((await create('book_two')).status,429);
  r=await request('/api/reading/books',null,bob.cookie);assert.deepEqual((await r.json()).items,[]);
  r=await mf.dispatchFetch(origin+'/api/reading/documents/doc_one?book_id=book_one&filename=original.txt',{method:'PUT',headers:{Origin:origin,Cookie:alice.cookie},body:'第一章 原创\n\n这是原创测试文本。'});assert.equal(r.status,200,await r.clone().text());
  const upload=()=>mf.dispatchFetch(origin+'/api/reading/documents/doc_big?book_id=book_one&filename=big.txt',{method:'PUT',headers:{Origin:origin,Cookie:alice.cookie},body:'文'.repeat(20000)});
  assert.equal((await upload()).status,429,'expanded frozen text is also metered');
  const usage=await request('/api/public-usage',null,alice.cookie);assert.equal(usage.status,200);assert.ok((await usage.json()).value.bytes<=tiny.bytes);
  const registry=await mf.getDurableObjectNamespace('REGISTRY');
  const internal=route=>registry.get(registry.idFromName('reading-public:v1')).fetch('https://registry/internal/'+route+'?id='+alice.id,{headers:{'X-Service-Key':bindings.INTERNAL_KEY}});
  assert.equal((await internal('ai-attempt')).status,200);assert.equal((await internal('ai-attempt')).status,200);assert.equal((await internal('ai-attempt')).status,200,'retired AI lifetime quota is ignored');
  r=await request('/service/api/quota-request',{reason:'原创扩容测试',quota:{...tiny,books:2}},alice.cookie);assert.equal(r.status,200);
  assert.equal((await request('/service/api/quota-request',{reason:'重复申请',quota:tiny},alice.cookie)).status,409);
  assert.equal((await create('book_two')).status,429,'quota request is not approval');
  const updated=(await r.json()).user;
  r=await review(updated,{...tiny,books:2});assert.equal(r.status,200);
  assert.equal((await create('book_two')).status,200);
  r=await review((await r.json()).user,{...tiny,books:2},'suspended');assert.equal(r.status,200);
  assert.equal((await request('/api/reading/books',null,alice.cookie)).status,403,'existing sessions lose access immediately');
  assert.equal((await internal('ai-attempt')).status,403,'background AI cannot bypass suspension');
  assert.equal((await request('/service/api/logout',{},bob.cookie)).status,200);
  assert.equal((await request('/api/session',null,bob.cookie)).status,401);
  r=await request('/service/api/login',{username:'bobby',password:'fixture-password-123'});assert.equal(r.status,200);
  const signedIn=await request('/api/session',null,cookie(r));assert.equal(signedIn.status,200);const profile=await signedIn.json();assert.equal(profile.login_id,'bobby');assert.equal(profile.hosted,true);assert.equal(profile.user_id,bob.id);const publicProfile=await(await request('/api/reading/profile',null,cookie(r))).json();assert.equal(publicProfile.login_id,'bobby');
  r=await mf.dispatchFetch(origin+'/service/api/login',{method:'POST',headers:{Origin:'https://other.test'},body:'{}'});assert.equal(r.status,403);
 }finally{await mf.dispose();}
});

async function approvedFixture(mf,q){
 const origin='https://reading.test';
 const req=(path,body,cookie='',method=body?'POST':'GET')=>mf.dispatchFetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const owner=(await req('/service/api/owner-login',{key:bindings.OWNER_KEY})).headers.get('set-cookie').split(';')[0];
 assert.equal((await req('/service/api/owner/policy',initialPolicy,owner)).status,200);
 const r=await req('/service/api/register',{username:'reader',password:'fiction-only-password',name:'原创读者',contact:'fixture@example.test',reason:'原创测试'}),cookie=r.headers.get('set-cookie').split(';')[0],user=(await r.json()).user;
 assert.equal((await req('/service/api/owner/review',{id:user.id,expectedRevision:0,status:'active',quota:q,note:''},owner)).status,200);
 return {req,cookie,owner,user};
}

test('provider probes and tool continuations use daily service limits, not a lifetime AI allowance',async()=>{
 let attempts=0;
 const mf=new Miniflare({...options,outboundService:async request=>{
  attempts++;assert.equal(request.headers.get('authorization'),'Bearer fixture-user-model-key');
  const body=await request.json();
  return FixtureResponse.json({choices:[{message:!body.tools?.length||body.messages.at(-1).role==='tool'?{role:'assistant',content:'原创测试内容。'}:{role:'assistant',content:null,tool_calls:[{id:'fixture_source',type:'function',function:{name:'read_source',arguments:'{"start":0,"limit":100}'}}]}}]});
 }});
 try{
  const {req,cookie,owner}=await approvedFixture(mf,{...suggestedQuota,aiCalls:0,requestsPerDay:4});
  const settings={provider:'deepseek',api_key:'fixture-user-model-key',model:'fixture-model',name:'原创伙伴'};
  let r=await req('/api/ai-settings/test',settings,cookie);assert.equal(r.status,200,await r.clone().text());assert.equal(attempts,2);
  const text=await r.text();assert.ok(!text.includes(settings.api_key));
  assert.equal((await req('/api/ai-settings',{...settings,proof:JSON.parse(text).proof,revision:0},cookie,'PUT')).status,200);
  r=await req('/api/ai-settings/test',settings,cookie);assert.equal(r.status,429);assert.equal(attempts,2,'quota rejection must not contact provider');
  const me=await(await req('/service/api/me',null,cookie)).json();assert.equal(me.usage.aiCalls,2);
  assert.equal(me.usage.requests,4);
  assert.equal((await req('/service/api/owner/review',{id:me.user.id,expectedRevision:me.user.revision,status:'active',quota:{...suggestedQuota,requestsPerDay:10},note:'每日服务额度调整'},owner)).status,200);
  r=await req('/api/ai-settings/test',settings,cookie);assert.equal(r.status,200);assert.equal(attempts,4);

 }finally{await mf.dispose();}
});

test('daily exhaustion preserves account/owner access; concurrent record writes and upload retries stay bounded',async()=>{
 const mf=new Miniflare(options);
 try{
  const {req,cookie,owner,user}=await approvedFixture(mf,{...suggestedQuota,books:1,requestsPerDay:20});
  const responses=await Promise.all(['one','two'].map(book_id=>req('/api/reading/books',{book_id,title:'原创'},cookie)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
  const book=(await(await req('/api/reading/books',null,cookie)).json()).items[0];
  const source='第一章 原创\n\n只保存一次的正文。';
  const upload=()=>mf.dispatchFetch('https://reading.test/api/reading/documents/doc_repeat?book_id='+book.book_id+'&filename=fiction.txt',{method:'PUT',headers:{Origin:'https://reading.test',Cookie:cookie},body:source});
  assert.equal((await upload()).status,200);
  assert.equal(await(await req('/api/reading/documents/doc_repeat/text',null,cookie)).text(),source);
  assert.equal(await(await req('/api/reading/documents/doc_repeat/original',null,cookie)).text(),source);
  const before=(await(await req('/api/public-usage',null,cookie)).json()).value;
  assert.equal((await upload()).status,200);
  const after=(await(await req('/api/public-usage',null,cookie)).json()).value;assert.deepEqual(after,before);
  const updated=(await(await req('/service/api/me',null,cookie)).json()).user;
  assert.equal((await req('/service/api/owner/review',{id:user.id,expectedRevision:updated.revision,status:'active',quota:{...suggestedQuota,books:1,requestsPerDay:1},note:''},owner)).status,200);
  assert.equal((await req('/api/session',null,cookie)).status,429);
  assert.equal((await req('/service/api/me',null,cookie)).status,200);
  assert.equal((await req('/service/api/owner/list',null,owner)).status,200);
  assert.equal((await req('/service/api/logout',{},cookie)).status,200);
 }finally{await mf.dispose();}
});

test('public binary storage chunks multi-megabyte originals, survives runtime restart, and denies cross-owner downloads',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const persist=await mkdtemp(join(tmpdir(),'reading-public-'));let mf=new Miniflare({...options,durableObjectsPersist:persist});
 try{
  const {req,cookie}=await approvedFixture(mf,suggestedQuota);
  assert.equal((await req('/api/reading/books',{book_id:'binary_book',title:'原创 PDF'},cookie)).status,200);
  const bytes=new Uint8Array(3*1024*1024);bytes.set(new TextEncoder().encode('%PDF-1.4\nOriginal fictional fixture\n'));bytes[bytes.length-1]=71;
  let r=await mf.dispatchFetch('https://reading.test/api/reading/documents/binary_doc?book_id=binary_book&filename=fiction.pdf',{method:'PUT',headers:{Origin:'https://reading.test',Cookie:cookie},body:bytes});assert.equal(r.status,200,await r.clone().text());
  let file=await req('/api/reading/documents/binary_doc/original',null,cookie);assert.equal(file.status,200);assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);
  await mf.dispose();mf=new Miniflare({...options,durableObjectsPersist:persist});
  r=await mf.dispatchFetch('https://reading.test/api/reading/documents/binary_doc/original',{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
  r=await mf.dispatchFetch('https://reading.test/api/reading/documents/binary_doc/original');assert.equal(r.status,401);
 }finally{await mf.dispose();await rm(persist,{recursive:true,force:true});}
});
