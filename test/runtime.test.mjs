import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep,basename } from 'node:path';
import { issueToken,hmacHex } from '../src/core/auth.mjs';
import { docxFixture,epubFixture } from '../src/cloudflare/document-fixtures.mjs';
const bindings={READER_TOKEN:'fixture-password',SESSION_SECRET:'fixture-session-secret',AI_SHARED_SECRET:'fixture-agent-secret',AI_MODE:'mock',DEFAULT_USER_ID:'reader'};
const makeRuntime=(persist,override={})=>new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings:{...bindings,...override},...(persist?{durableObjectsPersist:join(persist,'do'),r2Persist:join(persist,'r2')}:{})});
async function auth(user='alice'){return `Bearer ${await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:user})}`;}
async function req(mf,path,method='GET',body,user='alice',headers={}) {
  const response=await mf.dispatchFetch('https://reading.example.test'+path,{method,headers:{Authorization:await auth(user),...(body!==undefined?{'Content-Type':typeof body==='string'?'application/octet-stream':'application/json'}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return response;
}
async function data(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function book(mf,id='book_a',user='alice'){
  return data(await req(mf,'/api/reading/books','POST',{book_id:id,title:'沿着海岸慢慢走',author:'示例作者'},user));
}
async function document(mf,id='doc_a',user='alice'){
  return data(await req(mf,`/api/reading/documents/${id}?book_id=book_a&filename=sample.txt`,'PUT','第一章 海边\n\n他收起地图，沿着海岸慢慢走。\n\n第二章 回家\n\n夜色落下来。',user));
}
async function thread(mf,id='thread_a',user='alice',extra={}){
  return data(await req(mf,'/api/reading/threads','POST',{thread_id:id,book_id:'book_a',title:'讨论海边',opening:'这句话像告别吗？',opening_message_id:'message_'+id,turn_id:'turn_'+id,delivery_id:'delivery_'+id,...extra},user));
}
test('login uses HttpOnly cookies and rejects wrong password and cross-site login',async()=>{
  const mf=makeRuntime();try{
    assert.equal((await mf.dispatchFetch('https://reading.example.test/api/reading/books')).status,401);
    const login=await mf.dispatchFetch('https://reading.example.test/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:bindings.READER_TOKEN})});
    assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await mf.dispatchFetch('https://reading.example.test/api/session',{headers:{cookie}})).status,200);
    assert.equal((await mf.dispatchFetch('https://reading.example.test/api/session',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await mf.dispatchFetch('https://reading.example.test/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"wrong"}'})).status,401);
  }finally{await mf.dispose();}
});
test('owner isolation blocks cross-user books, documents and threads',async()=>{
  const mf=makeRuntime();try{
    await book(mf);await document(mf);await thread(mf);
    for(const path of ['/api/reading/books/book_a','/api/reading/documents/doc_a','/api/reading/threads/thread_a'])assert.equal((await req(mf,path,'GET',undefined,'bob')).status,404);
    assert.equal((await data(await req(mf,'/api/reading/books','GET',undefined,'bob'))).items.length,0);
    await book(mf,'book_a','bob');assert.equal((await data(await req(mf,'/api/reading/books'))).items.length,1);
  }finally{await mf.dispose();}
});
test('mock discussion replies, continuous turns, retries and unread remain persistent',async()=>{
  const mf=makeRuntime();try{
    await book(mf);await document(mf);const first=await thread(mf);assert.equal(first.delivery_status,'completed');
    const message={message_id:'message_next',turn_id:'turn_next',delivery_id:'delivery_next',text:'再说一点'};
    await data(await req(mf,'/api/reading/threads/thread_a/messages','POST',message));
    await data(await req(mf,'/api/reading/threads/thread_a/messages','POST',message));
    const rows=(await data(await req(mf,'/api/reading/messages?thread_id=thread_a'))).items;
    assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.author==='assistant').length,2);
    assert.match(rows.find(r=>r.author==='assistant').text,/Mock/);
    assert.equal((await data(await req(mf,'/api/reading/unread'))).items[0].count,2);
    const last=rows.sort((a,b)=>a.sequence-b.sequence).at(-1);await data(await req(mf,'/api/reading/threads/thread_a/read','POST',{message_id:last.message_id}));
    assert.equal((await data(await req(mf,'/api/reading/unread'))).items.length,0);
    assert.equal((await req(mf,'/api/reading/threads/thread_a/messages','POST',{...message,text:'changed'})).status,409);
  }finally{await mf.dispose();}
});
test('frozen source survives document replacement and forged excerpt is rejected',async()=>{
  const mf=makeRuntime();try{
    await book(mf);const doc=await document(mf);
    const oldPath=`/api/reading/documents/doc_a/source?book_id=book_a&version=${doc.version}&sha=${doc.text_sha256}&start=0&limit=4000`;
    const old=await data(await req(mf,oldPath));
    await data(await req(mf,'/api/reading/documents/doc_b?book_id=book_a&filename=new.txt','PUT','替换后的另一份原文。'));
    assert.equal((await data(await req(mf,oldPath))).text,old.text);
    assert.equal((await req(mf,'/api/reading/annotations','POST',{annotation_id:'note_bad',book_id:'book_a',document_id:'doc_a',start:0,end:5,exact:'伪造原文'})).status,409);
  }finally{await mf.dispose();}
});
test('AI callback signature, duplicate commit and scoped source capability',async()=>{
  const mf=makeRuntime();try{
    await book(mf);const doc=await document(mf);await thread(mf);
    assert.equal((await mf.dispatchFetch('https://reading.example.test/api/reading/gateway/reply',{method:'POST',body:'{}'})).status,401);
    const token=await issueToken(bindings.AI_SHARED_SECRET,{purpose:'source',user_id:'alice',thread_id:'thread_a'});
    const input={thread_id:'thread_a',document_id:'doc_a',version:doc.version,sha:doc.text_sha256,start:0,limit:20};
    const read=await mf.dispatchFetch('https://reading.example.test/api/reading/gateway/source',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(read.status,200);
    const wrong=await mf.dispatchFetch('https://reading.example.test/api/reading/gateway/source',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...input,thread_id:'other_thread'})});assert.equal(wrong.status,403);
    const payload={protocol:'reading-status-v1',owner_id:'alice',thread_id:'thread_a',turn_id:'turn_thread_a',status:'processing',retryable:false};
    const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000));
    const status=await mf.dispatchFetch('https://reading.example.test/api/reading/gateway/status',{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature-V2':await hmacHex(bindings.AI_SHARED_SECRET,`${timestamp}.${raw}`)},body:raw});
    assert.equal(status.status,200);assert.equal((await data(await req(mf,'/api/reading/threads/thread_a'))).delivery_status,'completed');
  }finally{await mf.dispose();}
});
test('library survives full runtime destruction and rebuild',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reading-release-'));let mf=makeRuntime(dir);
  try{await book(mf);await document(mf);await thread(mf);await mf.dispose();mf=makeRuntime(dir);
    assert.equal((await data(await req(mf,'/api/reading/messages?thread_id=thread_a'))).items.length,2);
    assert.equal((await req(mf,'/api/reading/documents/doc_a/text')).status,200);
  }finally{await mf.dispose();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&basename(dir).startsWith('reading-release-'));await rm(dir,{recursive:true,force:true});}
});
test('real workerd parses fictional DOCX and EPUB chapter order',async()=>{
  const mf=makeRuntime();try{
    await book(mf);
    for(const [name,bytes] of [['docx',docxFixture()],['epub',epubFixture()]]) {
      const response=await mf.dispatchFetch(`https://reading.example.test/api/reading/documents/doc_${name}?book_id=book_a&filename=fixture.${name}`,{method:'PUT',headers:{Authorization:await auth(),'Content-Type':'application/octet-stream'},body:bytes});
      const doc=await data(response);assert.equal(doc.parse_status,'ready');
      const text=await (await req(mf,`/api/reading/documents/doc_${name}/text`)).text();
      assert.match(text,name==='epub'?/先看海/:/风吹过来/);
      if(name==='epub')assert.ok(text.indexOf('先看海')<text.indexOf('再回家'));
    }
  }finally{await mf.dispose();}
});
test('pending Agent turns are released in FIFO order after signed atomic callbacks',async()=>{
  const mf=makeRuntime(undefined,{AI_MODE:'webhook'});try{
    await book(mf);await document(mf);await thread(mf);
    const message={message_id:'message_second',turn_id:'turn_second',delivery_id:'delivery_second',text:'第二句'};
    const queued=await data(await req(mf,'/api/reading/threads/thread_a/messages','POST',message));assert.equal(queued.dispatch.status,'pending');
    const apply=async(turn_id,delivery_id,text)=>{
      const payload={protocol:'reading-reply-v1',owner_id:'alice',thread_id:'thread_a',turn_id,delivery_id,actions:[{kind:'text',text,index:0,count:1}],terminal:{status:'completed',retryable:false}};
      const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000));
      return data(await mf.dispatchFetch('https://reading.example.test/api/reading/gateway/reply',{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature-V2':await hmacHex(bindings.AI_SHARED_SECRET,`${timestamp}.${raw}`)},body:raw}));
    };
    await apply('turn_thread_a','delivery_thread_a','首轮回复');
    const repeated=await apply('turn_thread_a','delivery_thread_a','首轮回复');assert.equal(repeated.duplicate,true);
    await apply('turn_second','delivery_second','第二轮回复');
    const rows=(await data(await req(mf,'/api/reading/messages?thread_id=thread_a'))).items;assert.equal(rows.length,4);
    assert.equal((await data(await req(mf,'/api/reading/threads/thread_a'))).delivery_status,'completed');
  }finally{await mf.dispose();}
});
