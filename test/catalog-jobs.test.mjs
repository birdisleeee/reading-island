import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,Response as MFResponse} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
import {build} from 'esbuild';
const content='*** START OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***\n'+'原创任务测试。'.repeat(80)+'\n*** END OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***';
const bindings={SESSION_SECRET:'catalog-jobs-fixture-secret',AI_MODE:'mock'};
const catalog=query=>({results:[{id:query==='second'?124:123,title:'原创 '+query,authors:[{name:'原创作者'}],copyright:false,languages:['zh'],formats:{'text/plain; charset=utf-8':'fixture'}}]});
async function waitFor(read,predicate){for(let attempt=0;attempt<80;attempt++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out waiting for durable catalog task');}
function fixture(persist,external){return new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},durableObjectsPersist:persist,r2Buckets:['BOOK_BUCKET'],r2Persist:join(persist,'r2'),bindings,outboundService:external});}
const req=async(mf,method,body,owner='alice')=>mf.dispatchFetch('https://reading.test/api/book-catalog/jobs',{method,headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const items=async mf=>(await(await req(mf,'GET')).json()).items;
const usage=async(mf,owner='alice')=>(await(await mf.dispatchFetch('https://reading.test/api/book-catalog/usage',{headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner})}})).json());
test('durable catalog jobs survive leaving/restart, keep earlier search results, isolate owners and import once',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'reading-catalog-jobs-'));let searches=0,downloads=0;
 const external=async request=>{const url=new URL(request.url);if(url.hostname==='gutendex.com'){searches++;await new Promise(resolve=>setTimeout(resolve,150));return MFResponse.json(catalog(url.searchParams.get('search')));}downloads++;await new Promise(resolve=>setTimeout(resolve,150));return new MFResponse(content,{headers:{'Content-Type':'text/plain'}});};
 let mf=fixture(persist,external);
 try{
  const job={job_id:'search_first',type:'search',query:'first',language:'zh'};
  const queued=await req(mf,'POST',job);assert.equal(queued.status,200);assert.equal((await queued.json()).status,'queued');
  assert.equal((await req(mf,'POST',job)).status,200);
  assert.equal((await req(mf,'POST',{...job,query:'changed'})).status,409);
  assert.equal((await(await req(mf,'GET',null,'bob')).json()).items.length,0);
  await waitFor(()=>items(mf),list=>list.some(j=>j.job_id===job.job_id&&j.status==='succeeded'));
  assert.equal(searches,1);
  const firstList=await(await req(mf,'GET')).json();assert.equal(firstList.usage.searches.remaining,9);assert.equal(firstList.usage.imports.remaining,3);
  assert.equal((await usage(mf,'bob')).searches.remaining,10);
  await req(mf,'POST',{job_id:'search_second',type:'search',query:'second'});
  await waitFor(()=>items(mf),list=>list.some(j=>j.job_id==='search_second'&&j.status==='succeeded'));
  await mf.dispose();mf=fixture(persist,external);
  const restored=await items(mf);assert.equal(restored.length,2);assert.equal(restored.find(j=>j.job_id==='search_first').result.items[0].candidate_id,'gutenberg_123');
  const importing={job_id:'import_first',type:'import',candidate_id:'gutenberg_123',search_job_id:'search_first'};
  assert.equal((await req(mf,'POST',importing)).status,200);
  const saved=await waitFor(()=>items(mf),list=>list.some(j=>j.job_id==='import_first'&&j.status==='succeeded'));
  assert.equal(saved.find(j=>j.job_id==='import_first').result.book_id,'catalog_gutenberg_123');
  await req(mf,'POST',{...importing,job_id:'import_again'});
  await waitFor(()=>items(mf),list=>list.some(j=>j.job_id==='import_again'&&j.status==='succeeded'));
  assert.equal(downloads,1,'duplicate import returns existing frozen book without another download');
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
  assert.equal((await stub.call('alice','list',{kind:'book'})).value.items.length,1);
 }finally{await mf.dispose();await rm(persist,{recursive:true,force:true});}
});
test('catalog job failures remain visible and never retry without a new user submission',async()=>{
 const persist=await mkdtemp(join(tmpdir(),'reading-catalog-failure-'));let requests=0;
 const privateMarker='upstream-private-body-and-credential-fixture';
 const external=async()=>{requests++;return new MFResponse(privateMarker,{status:503,headers:{'x-private-fixture':privateMarker}});};
 let mf=fixture(persist,external);
 try{
  assert.equal((await mf.dispatchFetch('https://reading.test/api/book-catalog/jobs')).status,401);
  assert.equal((await req(mf,'POST',{job_id:'bad',type:'search',query:'x'})).status,400);
  assert.equal((await req(mf,'POST',{job_id:'bad',type:'search',query:'valid',owner:'bob'})).status,400);
  await req(mf,'POST',{job_id:'failed',type:'search',query:'valid'});
  const done=await waitFor(()=>items(mf),list=>list.some(j=>j.status==='failed'));
  assert.equal(done[0].error,'catalog_http_error');
  const diagnostic=done[0].diagnostic;
  assert.deepEqual({...diagnostic,elapsed_ms:0},{source:'gutendex',phase:'headers',reason:'http',status:503,elapsed_ms:0});
  assert(Number.isSafeInteger(diagnostic.elapsed_ms)&&diagnostic.elapsed_ms>=0);
  assert(!JSON.stringify(done).includes(privateMarker),'upstream body/header content never enters the stored job');
  assert.equal((await(await req(mf,'GET')).json()).usage.searches.remaining,9,'failed search usage is returned with task polling');
  assert.deepEqual((await(await req(mf,'GET',null,'bob')).json()).items,[],'another owner cannot see failure diagnostics');
  await mf.dispose();mf=fixture(persist,external);
  assert.deepEqual((await items(mf))[0].diagnostic,diagnostic,'failure diagnostics survive an owner-object restart');
  await req(mf,'POST',{job_id:'failed',type:'search',query:'valid'});
  assert.equal((await items(mf))[0].status,'failed');assert.equal(requests,1);
 }finally{await mf.dispose();await rm(persist,{recursive:true,force:true});}
});

test('catalog service-stage failures persist safely, retain budgets and never masquerade as upstream failures',async()=>{
 const privateMarker='private-service-exception-details-do-not-store';
 const built=await build({stdin:{contents:`import worker,{ReadingLibraryDO} from './dist/worker.mjs';export default worker;export class FaultLibrary extends ReadingLibraryDO{
   configureFailure(phase){this.failurePhase=phase;this.grantChecks=0;}
   async refreshGrant(){this.grantChecks=(this.grantChecks||0)+1;if(this.failurePhase==='grant_before'&&this.grantChecks===1||this.failurePhase==='grant_after'&&this.grantChecks===2)throw new Error('${privateMarker}');}
   beforeRecordWrite(kind,id,value){if(this.failurePhase==='persist'&&kind==='catalog_job'&&value.status==='succeeded')throw new Error('${privateMarker}');}
 }`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 let requests=0;
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'FaultLibrary',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async()=>{requests++;return MFResponse.json(catalog('fixture'));}});
 try{
  const namespace=await mf.getDurableObjectNamespace('READING_LIBRARY');
  for(const phase of ['grant_before','grant_after','persist']){
   const owner='owner_'+phase,stub=namespace.getByName('reading-island:v1:owner:'+owner),before=requests;
   await stub.configureFailure(phase);
   const input={job_id:'failure_'+phase,type:'search',query:'fixture'};
   assert.equal((await req(mf,'POST',input,owner)).status,200);
   const done=await waitFor(async()=>(await(await req(mf,'GET',null,owner)).json()).items,list=>list.some(j=>j.status==='failed'));
   assert.equal(done[0].error,'catalog_service_error');
   const diagnostic=done[0].diagnostic;
   assert.deepEqual({...diagnostic,elapsed_ms:0},{source:'service',phase,reason:'service_error',elapsed_ms:0});
   assert(Number.isSafeInteger(diagnostic.elapsed_ms)&&diagnostic.elapsed_ms>=0);
   assert(!JSON.stringify(done).includes(privateMarker),'exception messages and stack text must not persist');
   assert.equal(done[0].catalog_reserve,undefined,'internal status reservation is not exposed');
   assert.equal(requests-before,phase==='grant_before'?0:1);
   assert.equal((await usage(mf,owner)).searches.used,phase==='grant_before'?0:1,'only a real upstream attempt consumes catalog budget');
   assert.deepEqual((await(await req(mf,'GET',null,'unrelated_owner')).json()).items,[]);
   await req(mf,'POST',input,owner);
   assert.equal((await(await req(mf,'GET',null,owner)).json()).items[0].status,'failed');
   assert.equal(requests-before,phase==='grant_before'?0:1,'same task identity cannot rerun after failure');
  }
 }finally{await mf.dispose();}
});

test('catalog usage resets by UTC day without rewriting the stored previous-day budget',async()=>{
 const built=await build({stdin:{contents:`import worker,{ReadingLibraryDO} from './dist/worker.mjs';export default worker;export class UsageLibrary extends ReadingLibraryDO{seedBudget(value){this.ctx.storage.sql.exec("INSERT INTO reading_records(kind,id,book_id,value) VALUES('catalog_budget','daily','',?)",JSON.stringify(value));}readBudget(){return this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='catalog_budget' AND id='daily'").toArray()[0]?.value;}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'UsageLibrary',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings});
 try{
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
  const yesterday={day:new Date(Date.now()-86400000).toISOString().slice(0,10),searches:10,imports:3};
  await stub.seedBudget(yesterday);
  const value=await usage(mf);
  assert.equal(value.day,new Date().toISOString().slice(0,10));
  assert.equal(value.reset_at,new Date(Date.parse(value.day+'T00:00:00.000Z')+86400000).toISOString());
  assert.deepEqual(value.searches,{used:0,limit:10,remaining:10});assert.deepEqual(value.imports,{used:0,limit:3,remaining:3});
  assert.equal(await stub.readBudget(),JSON.stringify(yesterday),'usage GET does not persist an unnecessary budget reset');
 }finally{await mf.dispose();}
});
test('catalog tasks share the owner alarm with proactive discussions without losing the next scheduled run',async()=>{
 const built=await build({stdin:{contents:`import worker,{ReadingLibraryDO} from './dist/worker.mjs';export default worker;export class TestLibrary extends ReadingLibraryDO{async pendingAlarm(){return this.ctx.storage.getAlarm();}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'TestLibrary',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings:{...bindings,AI_MODE:'webhook',AI_WEBHOOK_URL:'https://agent.test/turn',AI_SHARED_SECRET:'fixture'},outboundService:async request=>MFResponse.json(catalog(new URL(request.url).searchParams.get('search')))});
 try{
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
  assert.equal((await stub.call('alice','createBook',{book_id:'fixture_book',title:'原创书'})).ok,true);
  assert.equal((await stub.call('alice','upload',{book_id:'fixture_book',document_id:'fixture_doc',filename:'original.txt',bytes:new TextEncoder().encode('原创正文。'.repeat(50))})).ok,true);
  const schedule=await stub.call('alice','putSchedule',{enabled:true,frequency:'daily',time:'23:59',weekday:0,timezone:'UTC',scope:'all',group_id:'',book_ids:[],instruction:'读一段再讨论。',revision:0,origin:'https://reading.test'});
  assert.equal(schedule.ok,true);const due=schedule.value.next_run;
  await req(mf,'POST',{job_id:'shared_alarm',type:'search',query:'first'});
  const early=await stub.pendingAlarm();assert(early<due);
  await waitFor(()=>items(mf),list=>list.some(j=>j.status==='succeeded'));
  assert.equal((await stub.call('alice','getSchedule')).value.next_run,due);
  assert.equal(await stub.pendingAlarm(),due);
 }finally{await mf.dispose();}
});
