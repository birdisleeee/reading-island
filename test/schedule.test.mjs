import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Response} from 'miniflare';
import {issueToken,hmacHex} from '../src/core/auth.mjs';
import {normalizeSchedule,nextOccurrence} from '../src/core/schedule.mjs';
const definition={enabled:true,frequency:'daily',time:'20:00',weekday:0,timezone:'Asia/Shanghai',scope:'books',book_ids:['book_a'],group_id:'',instruction:'先读原文，主动提出一个问题。'};

test('scheduled Webhook task reaches Agent receiver and signed reply produces one unread discussion',async()=>{
 const built=await build({stdin:{contents:`import worker,{ReadingLibraryDO} from './dist/worker.mjs';export default worker;export class TestLibrary extends ReadingLibraryDO{async makeDue(){const row=this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='settings' AND id='schedule'").toArray()[0];const value=JSON.parse(row.value);value.next_run=Date.now()-1000;this.ctx.storage.sql.exec("UPDATE reading_records SET value=? WHERE kind='settings' AND id='schedule'",JSON.stringify(value));await this.ctx.storage.setAlarm(Date.now()+50);}async duplicateWake(){await this.alarm();}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const bindings={SESSION_SECRET:'schedule-agent-fixture-session',READER_TOKEN:'fixture',AI_MODE:'webhook',AI_WEBHOOK_URL:'https://agent.test/reading/turn',AI_SHARED_SECRET:'schedule-agent-fixture-signing',PUBLIC_BASE_URL:'https://reading.test'};
 const deliveries=[];
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'TestLibrary',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async request=>{
  assert.equal(request.url,bindings.AI_WEBHOOK_URL);const raw=await request.text(),stamp=request.headers.get('X-Webhook-Timestamp');
  assert.equal(request.headers.get('X-Webhook-Signature-V2'),await hmacHex(bindings.AI_SHARED_SECRET,stamp+'.'+raw));
  const payload=JSON.parse(raw);deliveries.push(payload);assert.equal(payload.protocol,'reading-turn-v1');assert.equal(payload.owner_id,'alice');assert.equal(payload.book.title,'原创海岸');assert.equal(payload.callback_url,'https://reading.test/api/reading/gateway/reply');assert(payload.source_access.token);
  return Response.json({status:'accepted',delivery_id:payload.delivery_id},{status:202});
 }});
 try{
  const req=async(path,method='GET',body)=>mf.dispatchFetch('https://reading.test'+path,{method,headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:'alice'}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await req('/api/reading/books','POST',{book_id:'book_a',title:'原创海岸'})).status,200);
  assert.equal((await mf.dispatchFetch('https://reading.test/api/reading/documents/doc_a?book_id=book_a&filename=original.txt',{method:'PUT',headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:'alice'}),'Content-Type':'application/octet-stream'},body:'第一章\n\n远处的灯依然亮着。'})).status,200);
  assert.equal((await req('/api/topic-schedule','PUT',{...definition,revision:0})).status,200);
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');await stub.makeDue();
  let schedule;for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,50));schedule=await (await req('/api/topic-schedule')).json();if(schedule.runs[0]?.status==='accepted')break;}
  assert.equal(schedule.runs[0]?.status,'accepted');assert.equal(deliveries.length,1);const payload=deliveries[0];const thread=await (await req('/api/reading/threads/'+payload.thread_id)).json();assert.equal(thread.book_id,'book_a');
  const raw=JSON.stringify({protocol:'reading-reply-v1',owner_id:'alice',thread_id:payload.thread_id,turn_id:payload.turn_id,delivery_id:payload.delivery_id,actions:[{kind:'text',index:0,count:1,text:'那盏灯为什么一直亮着？我们一起读读这段。'}],terminal:{status:'completed',retryable:false}}),stamp=String(Math.floor(Date.now()/1000));
  const callback=()=>mf.dispatchFetch(payload.callback_url,{method:'POST',headers:{'Content-Type':'application/json','X-Webhook-Timestamp':stamp,'X-Webhook-Signature-V2':hmac},body:raw});
  const hmac=await hmacHex(bindings.AI_SHARED_SECRET,stamp+'.'+raw);
  assert.equal((await callback()).status,200);assert.equal((await callback()).status,200);
  const unread=await (await req('/api/reading/unread')).json();assert.equal(unread.items[0].book_id,'book_a');assert.equal(unread.items[0].count,1);
  await stub.duplicateWake();assert.equal(deliveries.length,1);
 }finally{await mf.dispose();}
});
test('civil time scheduling handles daily/weekly, daylight-saving gaps and repeated minutes',()=>{
 assert.equal(new Date(nextOccurrence(definition,Date.parse('2026-10-14T11:59:00Z'))).toISOString(),'2026-10-14T12:00:00.000Z');
 assert.equal(new Date(nextOccurrence({...definition,frequency:'weekly',weekday:0},Date.parse('2026-10-14T12:00:00Z'))).toISOString(),'2026-10-18T12:00:00.000Z');
 assert.equal(new Date(nextOccurrence({...definition,timezone:'America/New_York',time:'02:30'},Date.parse('2026-03-08T05:00:00Z'))).toISOString(),'2026-03-09T06:30:00.000Z');
 assert.equal(new Date(nextOccurrence({...definition,timezone:'America/New_York',time:'01:30'},Date.parse('2026-11-01T05:45:00Z'))).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.equal(new Date(nextOccurrence({...definition,timezone:'Australia/Lord_Howe',time:'01:45'},Date.parse('2026-04-04T14:55:00Z'))).toISOString(),'2026-04-05T15:15:00.000Z');
 assert.throws(()=>normalizeSchedule({...definition,time:'25:00'}));assert.throws(()=>normalizeSchedule({...definition,timezone:'Mars/City'}));assert.throws(()=>normalizeSchedule({...definition,book_ids:[]}));
});
test('real workerd alarm creates one scoped topic, injects persona first, survives duplicate wake, and can pause',async()=>{
 // Test-only subclass can make an occurrence due; no clock/testing endpoint is shipped.
 const built=await build({stdin:{contents:`import worker,{ReadingLibraryDO} from './dist/worker.mjs';export default worker;export class TestLibrary extends ReadingLibraryDO{async makeDue(){const row=this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='settings' AND id='schedule'").toArray()[0];const value=JSON.parse(row.value);value.next_run=Date.now()-1000;this.ctx.storage.sql.exec("UPDATE reading_records SET value=? WHERE kind='settings' AND id='schedule'",JSON.stringify(value));await this.ctx.storage.setAlarm(Date.now()+50);}async duplicateWake(){await this.alarm();}async pendingAlarm(){return this.ctx.storage.getAlarm();}async makeLate(){const row=this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='settings' AND id='schedule'").toArray()[0];const value=JSON.parse(row.value);value.next_run=Date.now()-8*3600000;this.ctx.storage.sql.exec("UPDATE reading_records SET value=? WHERE kind='settings' AND id='schedule'",JSON.stringify(value));await this.ctx.storage.setAlarm(Date.now()+50);}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 let failing=false;const calls=[],bindings={SESSION_SECRET:'schedule-fixture-master',READER_TOKEN:'fixture',AI_MODE:'mock'};
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'TestLibrary',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async request=>{const value=await request.json();calls.push(value);if(failing)return new Response('',{status:401});return Response.json({choices:[{message:value.messages.at(-1).role==='tool'?{content:'作为你的纸上朋友，我想聊聊海岸意味着什么。'}:{role:'assistant',content:null,tool_calls:[{id:'source_1',type:'function',function:{name:'read_source',arguments:'{"start":0,"limit":100}'}}]}}]});}});
 try{
  const req=async(path,method='GET',body,owner='alice')=>mf.dispatchFetch('https://reading.test'+path,{method,headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await mf.dispatchFetch('https://reading.test/api/topic-schedule')).status,401);
  assert.equal((await req('/api/topic-schedule','PUT',{...definition,revision:0})).status,409);
  await req('/api/reading/books','POST',{book_id:'book_a',title:'原创海岸'});
  const upload=await mf.dispatchFetch('https://reading.test/api/reading/documents/doc_a?book_id=book_a&filename=original.txt',{method:'PUT',headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:'alice'}),'Content-Type':'application/octet-stream'},body:'第一章\n\n海岸在地图尽头，他把书放在窗边。'});assert.equal(upload.status,200);
  const ai={provider:'deepseek',model:'deepseek-flash',api_key:'fixture-api',name:'纸上朋友',allow_upload:true,persona:'你是纸上朋友，温柔且有独立见解，使用自然短段落。',system_prompt:''};
  const proof=await (await req('/api/ai-settings/test','POST',ai)).json();assert.equal(proof.ok,true);assert.equal((await req('/api/ai-settings','PUT',{...ai,proof:proof.proof,revision:0})).status,200);
  const saved=await req('/api/topic-schedule','PUT',{...definition,revision:0});assert.equal(saved.status,200);const value=await saved.json();assert.equal(value.revision,1);assert(value.next_run>Date.now());
  assert.equal((await req('/api/topic-schedule','PUT',{...definition,revision:0})).status,409);
  assert.equal((await req('/api/topic-schedule','PUT',{...definition,revision:0},'bob')).status,409);
  assert.equal((await (await req('/api/topic-schedule','GET',null,'bob')).json()).enabled,false);
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');await stub.makeDue();
  let current;for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,50));current=await (await req('/api/topic-schedule')).json();if(current.runs[0]?.status==='completed')break;}
  assert.equal(current.runs[0]?.status,'completed',JSON.stringify(current));assert.equal(calls.length,4);
  assert(calls[2].tools.every(tool=>tool.function.name==='read_source'));const actual=calls[2].messages,personaIndex=actual.findIndex(m=>m.content?.includes(ai.persona)),sourceIndex=actual.findIndex(m=>m.content?.includes('当前共读资料'));assert(personaIndex>0&&personaIndex<sourceIndex);
  const threads=await (await req('/api/reading/threads')).json();assert.equal(threads.items.length,1);assert.equal(threads.items[0].book_id,'book_a');assert.equal(threads.items[0].scheduled,true);
  await stub.duplicateWake();assert.equal(calls.length,4);
  const paused=await (await req('/api/topic-schedule','PUT',{...definition,enabled:false,revision:1})).json();assert.equal(paused.next_run,null);
  assert.equal(await stub.pendingAlarm(),null);
  await req('/api/topic-schedule','PUT',{...definition,scope:'reading',revision:2});await stub.makeDue();
  for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,50));current=await (await req('/api/topic-schedule')).json();if(current.runs.some(r=>r.status==='skipped_no_book'))break;}
  assert(current.runs.some(r=>r.status==='skipped_no_book'));assert.equal(calls.length,4);
  await stub.makeLate();for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,50));current=await (await req('/api/topic-schedule')).json();if(current.runs.some(r=>r.status==='skipped_late'))break;}assert(current.runs.some(r=>r.status==='skipped_late'));assert.equal(calls.length,4);
  await req('/api/topic-schedule','PUT',{...definition,revision:3});failing=true;await stub.makeDue();for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,50));current=await (await req('/api/topic-schedule')).json();if(current.runs.some(r=>r.status==='failed'))break;}assert(current.runs.some(r=>r.status==='failed'));assert.equal(calls.length,5);await stub.duplicateWake();assert.equal(calls.length,5);
  failing=false;const bobProof=await (await req('/api/ai-settings/test','POST',ai,'bob')).json();await req('/api/ai-settings','PUT',{...ai,proof:bobProof.proof,revision:0},'bob');assert.equal((await req('/api/topic-schedule','PUT',{...definition,revision:0},'bob')).status,404);
 }finally{await mf.dispose();}
});
