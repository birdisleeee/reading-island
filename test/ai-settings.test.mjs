import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,Response} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
const bindings={SESSION_SECRET:'fixture-session-master',READER_TOKEN:'fixture-password',AI_MODE:'mock'};
const input={provider:'deepseek',api_url:'ignored',model:'deepseek-flash',name:'共读伙伴',system_prompt:'自然讨论',api_key:'fixture-paid-key'};
async function setup(){const calls=[];const mf=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async request=>{
 assert.equal(new URL(request.url).hostname,'api.deepseek.com');const body=await request.json();calls.push(body);assert.equal(body.thinking.type,'disabled');
 if(request.headers.get('authorization')!=='Bearer fixture-paid-key')return new Response('provider error would contain secret', {status:401});
 return Response.json({choices:[{message:body.messages.at(-1).role==='tool'?{content:'原文中的海岸让人想到告别。'}:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read_source',arguments:'{"start":0,"limit":100}'}}]}}]});
 }});
 const req=async(path,method='GET',body,user='alice',headers={})=>mf.dispatchFetch('https://reading.example.test'+path,{method,headers:{Authorization:`Bearer ${await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:user})}`,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {mf,req,calls};}
test('DeepSeek test -> save -> encrypted storage -> real discussion protocol with a fixture provider',async()=>{
 const {mf,req,calls}=await setup();try{
  assert.equal((await (await req('/api/ai-settings')).json()).configured,false);
  const tested=await (await req('/api/ai-settings/test','POST',input)).json();assert.equal(tested.ok,true,JSON.stringify({result:tested,calls:calls.length}));assert.equal(calls.length,2);assert.equal(calls[0].max_tokens,256);
  const save=await req('/api/ai-settings','PUT',{...input,proof:tested.proof,revision:0});assert.equal(save.status,200);const publicValue=await save.json();assert.equal(publicValue.has_key,true);assert.equal(publicValue.api_key,undefined);assert.equal(publicValue.api_url,'https://api.deepseek.com/chat/completions');
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
  const stored=await stub.call('alice','getAISettings');assert.ok(stored.value.cipher);assert.equal(JSON.stringify(stored).includes(input.api_key),false);
  assert.equal((await (await req('/api/ai-settings','GET',undefined,'bob')).json()).configured,false);
  const config=await (await req('/api/config')).json();assert.equal(config.aiMode,'model');assert.equal(config.aiName,input.name);assert.equal(JSON.stringify(config).includes(input.api_key),false);
  const blank=await (await req('/api/ai-settings/test','POST',{...input,api_key:''})).json();assert.equal(blank.ok,true);
  assert.equal((await req('/api/ai-settings','PUT',{...input,model:'changed',proof:tested.proof,revision:1})).status,409);
  assert.equal((await req('/api/ai-settings','PUT',{...input,proof:tested.proof,revision:0})).status,409);
  assert.equal((await req('/api/ai-settings','PUT',{...input,proof:tested.proof,revision:0},'bob')).status,409);
  await req('/api/reading/books','POST',{book_id:'book_a',title:'原创书籍'});
  const upload=await mf.dispatchFetch('https://reading.example.test/api/reading/documents/doc_a?book_id=book_a&filename=sample.txt',{method:'PUT',headers:{Authorization:`Bearer ${await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:'alice'})}`,'Content-Type':'application/octet-stream'},body:'第一章 海边\n\n他收起地图，沿着海岸慢慢走。'});assert.equal(upload.status,200);
  const thread=await req('/api/reading/threads','POST',{thread_id:'thread_a',book_id:'book_a',title:'海边',opening:'这段像告别吗？',opening_message_id:'message_a',turn_id:'turn_a',delivery_id:'delivery_a'});assert.equal(thread.status,200);assert.equal((await thread.json()).delivery_status,'completed');
  const messages=await (await req('/api/reading/messages?thread_id=thread_a')).json();assert.match(messages.items.find(item=>item.author==='assistant').text,/海岸/);
  // An unreadable saved key (for example after master-secret rotation) must not leave a turn processing forever.
  const damaged=await stub.call('alice','putAISettings',{...stored.value,revision:1,cipher:'invalid'});assert.equal(damaged.ok,true);
  const failed=await req('/api/reading/threads','POST',{thread_id:'thread_b',book_id:'book_a',title:'另一个议题',opening:'继续读',opening_message_id:'message_b',turn_id:'turn_b',delivery_id:'delivery_b'});assert.equal(failed.status,200);assert.equal((await failed.json()).delivery_status,'failed');
 }finally{await mf.dispose();}
});
test('settings auth, cross-site, untested config and provider errors fail without leaking keys',async()=>{
 const {mf,req}=await setup();try{
  assert.equal((await mf.dispatchFetch('https://reading.example.test/api/ai-settings')).status,401);
  assert.equal((await req('/api/ai-settings/test','POST',input,'alice',{origin:'https://evil.example'})).status,403);
  assert.equal((await req('/api/ai-settings','PUT',{...input,revision:0})).status,409);
  const bad=await req('/api/ai-settings/test','POST',{...input,api_key:'wrong-key'});const error=await bad.json();assert.equal(error.error,'model_auth_failed');assert.equal(JSON.stringify(error).includes('wrong-key'),false);assert.equal(JSON.stringify(error).includes('provider error'),false);
  const invalid=await req('/api/ai-settings/test','POST',{...input,provider:'compatible',api_url:'https://127.0.0.1/private'});assert.equal(invalid.status,400);
 }finally{await mf.dispose();}
});
