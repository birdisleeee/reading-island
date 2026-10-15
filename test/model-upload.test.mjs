import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,Response} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
import {runModel} from '../src/core/model-adapter.mjs';

test('upload tool is opt-in, absent from probes, and rejects caller-chosen identities and URLs',async()=>{
 const env={MODEL_API_URL:'https://model.test/chat',MODEL_API_KEY:'fixture',MODEL_NAME:'fixture'},payload={book:{title:'原创'},discussion:{topic:'保存文本'},user_message:{text:'把文本放进书库'}};
 for(const probe of [false,true]){
  let writes=0;await runModel({env,payload,probe,...(probe?{addBook:()=>{writes++;}}:{}),fetchImpl:async(url,init)=>{assert.equal(JSON.parse(init.body).tools,undefined);return Response.json({choices:[{message:{content:'没有新增书籍。'}}]});}});assert.equal(writes,0);
 }
 for(const extra of [{owner_id:'another'},{book_id:'existing'},{url:'https://download.test/book'}]){
  await assert.rejects(runModel({env,payload,addBook:()=>{throw new Error('must not write');},fetchImpl:async()=>Response.json({choices:[{message:{tool_calls:[{id:'fixture_upload',type:'function',function:{name:'add_book',arguments:JSON.stringify({title:'原创',content:'文字',...extra})}}]}}]})}),/Invalid book upload/);
 }
});

test('real workerd upload permission adds one frozen book without changing existing books or Agent upload APIs',async()=>{
 const bindings={SESSION_SECRET:'upload-fixture-session',READER_TOKEN:'fixture',AI_MODE:'mock'},calls=[],content='第一章 新的地图\n\n我们把今天的思考收进这本原创小册子。';
 const mf=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async request=>{
  const body=await request.json();calls.push(body);let message;
  if(body.messages.at(-1).role==='tool')message={content:'书籍已保存，可以回到书架打开。'};
  else if(body.max_tokens)message={role:'assistant',content:null,tool_calls:[{id:'probe_source',type:'function',function:{name:'read_source',arguments:'{"start":0,"limit":100}'}}]};
  else if(body.tools?.some(tool=>tool.function.name==='add_book'))message={role:'assistant',content:null,tool_calls:[{id:'add_one',type:'function',function:{name:'add_book',arguments:JSON.stringify({title:'今天的阅读札记',author:'阅读伙伴',content,format:'md'})}}]};
  else message={content:'当前没有上传权限。'};
  return Response.json({choices:[{message}]});
 }});
 try{
  const auth=async owner=>'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner});
  const req=async(route,method='GET',body,owner='alice')=>mf.dispatchFetch('https://reading.test'+route,{method,headers:{Authorization:await auth(owner),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const ai={provider:'deepseek',model:'deepseek-flash',name:'阅读伙伴',api_key:'fixture-key',allow_upload:false};
  const probe=await (await req('/api/ai-settings/test','POST',ai)).json();assert(probe.ok);
  assert.equal((await req('/api/ai-settings','PUT',{...ai,allow_upload:true,proof:probe.proof,revision:0})).status,409);
  assert.equal((await req('/api/ai-settings','PUT',{...ai,proof:probe.proof,revision:0})).status,200);
  await req('/api/reading/books','POST',{book_id:'book_a',title:'已有的原创书'});
  const upload=await mf.dispatchFetch('https://reading.test/api/reading/documents/doc_a?book_id=book_a&filename=book.txt',{method:'PUT',headers:{Authorization:await auth('alice')},body:'原有书籍文字'});assert.equal(upload.status,200);
  const opening=index=>({thread_id:'thread_'+index,book_id:'book_a',title:'新增小册子',opening:'请把今天的思考整理成新书。',opening_message_id:'message_'+index,turn_id:'turn_'+index,delivery_id:'delivery_'+index});
  assert.equal((await req('/api/reading/threads','POST',opening(0))).status,200);
  assert.equal((await (await req('/api/reading/books')).json()).items.length,1);
  ai.allow_upload=true;const enabled=await (await req('/api/ai-settings/test','POST',ai)).json();
  assert.equal((await req('/api/ai-settings','PUT',{...ai,proof:enabled.proof,revision:1})).status,200);
  assert.equal((await req('/api/reading/threads','POST',opening(1))).status,200);
  const books=(await (await req('/api/reading/books')).json()).items;assert.equal(books.length,2);
  const added=books.find(book=>book.created_by==='assistant');assert.equal(added.title,'今天的阅读札记');assert.equal(added.current_version,1);
  const text=await req('/api/reading/documents/'+added.current_document_id+'/text');assert.equal(await text.text(),content);
  assert.equal(await (await req('/api/reading/documents/doc_a/text')).text(),'原有书籍文字');
  assert.equal((await (await req('/api/reading/books',undefined,undefined,'bob')).json()).items.length,0);
  const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
  assert((await stub.call('alice','createThread',opening(2))).ok);assert((await stub.call('alice','claimDispatch',{turn_id:'turn_2'})).value.acquired);
  const args={turn_id:'turn_2',title:'幂等原创文本',content:'这是用于验证幂等上传的文字。',format:'txt'};
  const first=await stub.call('alice','modelAddBook',args),again=await stub.call('alice','modelAddBook',args);assert(first.ok&&again.ok);assert.deepEqual(first.value,again.value);
  assert.equal((await stub.call('alice','modelAddBook',{...args,content:'另一份不同正文'})).status,409);
  assert.equal((await stub.call('bob','modelAddBook',args)).status,403);
  assert.equal((await stub.call('alice','modelAddBook',{...args,turn_id:'turn_1'})).status,403);
  // Existing server/Agent HTTP ingestion remains available independently of the model switch.
  await req('/api/reading/books','POST',{book_id:'agent_book',title:'Agent 上传示例'});
  assert.equal((await mf.dispatchFetch('https://reading.test/api/reading/documents/agent_doc?book_id=agent_book&filename=agent.txt',{method:'PUT',headers:{Authorization:await auth('alice')},body:'来自已有 Agent 的原创文字'})).status,200);
  assert(calls.some(call=>call.tools?.some(tool=>tool.function.name==='add_book')));
 }finally{await mf.dispose();}
});
