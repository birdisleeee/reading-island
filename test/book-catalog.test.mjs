import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,Response as MFResponse} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
import {searchBookCatalog,downloadCatalogBook,CATALOG_LIMITS,catalogFailureDiagnostic} from '../src/cloudflare/book-catalog.mjs';
import {runModel} from '../src/core/model-adapter.mjs';
import {dispatchReadingTurn} from '../src/cloudflare/ai.mjs';
import {initialPolicy,suggestedQuota} from '../public-service/quota.mjs';

const content='*** START OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***\n第一章 海边\n'+ '原创测试文字。'.repeat(30)+'\n*** END OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***';
const catalog={results:[{id:123,title:'原创海边测试书',authors:[{name:'原创作者'}],copyright:false,languages:['zh'],formats:{'text/plain; charset=utf-8':'https://www.gutenberg.org/ebooks/123.txt.utf-8'}},{id:124,title:'不可导入书',copyright:true,formats:{'text/plain; charset=utf-8':'https://bad.test'}}]};
const candidate={candidate_id:'gutenberg_123',source_id:123};
const env={MODEL_API_URL:'https://model.test/chat',MODEL_API_KEY:'fixture',MODEL_NAME:'fixture'};
const payload={book:{title:'原创'},discussion:{topic:'搜书'},user_message:{text:'帮我找一本书并导入'}};

test('catalog uses only fixed hosts, filters candidates, bounds downloads and rejects redirects/incomplete/non-text files',async()=>{
  let queried;
  const result=await searchBookCatalog({query:'海边',language:'zh'},async url=>{queried=new URL(url);return Response.json(catalog);});
  assert.equal(queried.origin,'https://gutendex.com');assert.equal(queried.pathname,'/books/');assert.equal(result.items.length,1);
  assert.equal(result.items[0].candidate_id,'gutenberg_123');
  await assert.rejects(searchBookCatalog({query:'x',url:'https://localhost'}),/invalid_catalog_input/);
  const bytes=await downloadCatalogBook(candidate,async(url,options)=>{assert.equal(url,'https://gutenberg.pglaf.org/cache/epub/123/pg123.txt');assert.equal(options.redirect,'manual');return new Response(content, {headers:{'content-type':'text/plain'}});});
  assert.equal(new TextDecoder().decode(bytes),content);
  for(const response of [new Response(null,{status:302,headers:{location:'http://127.0.0.1'}}),new Response('x',{headers:{'content-type':'text/plain','content-length':String(CATALOG_LIMITS.maxBytes+1)}}),new Response(content,{headers:{'content-type':'text/html'}}),new Response('not a complete book '.repeat(20),{headers:{'content-type':'text/plain'}})]){
    await assert.rejects(downloadCatalogBook(candidate,async()=>response));
  }
});

test('catalog distinguishes a successful empty search from header/body timeouts and connection failures',async()=>{
  assert.deepEqual((await searchBookCatalog({query:'没有匹配作品'},async()=>Response.json({results:[]}))).items,[]);
  for(const name of ['TimeoutError','AbortError']){
    await assert.rejects(searchBookCatalog({query:'original'},async()=>{throw new DOMException('fixture',name);}),error=>error.status===503&&error.code==='catalog_timeout');
    const response=new Response(new ReadableStream({start(controller){controller.error(new DOMException('fixture',name));}}));
    await assert.rejects(searchBookCatalog({query:'original'},async()=>response),error=>error.status===503&&error.code==='catalog_timeout');
  }
  for(const fetchImpl of [async()=>{throw TypeError('fixture network failure');},async()=>new Response(new ReadableStream({start(controller){controller.error(TypeError('fixture connection interrupted'));}}))]){
    await assert.rejects(searchBookCatalog({query:'original'},fetchImpl),error=>error.status===503&&error.code==='catalog_network_error');
  }
});

test('catalog retains only bounded, fixed failure diagnostics and distinguishes HTTP, redirects and invalid data',async()=>{
  const privateText='private-user-key-and-response-text';
  const cases=[
    {fetch:async()=>new Response(privateText,{status:429}),code:'catalog_rate_limited',phase:'headers',reason:'http',status:429},
    {fetch:async()=>new Response(privateText,{status:403}),code:'catalog_http_error',phase:'headers',reason:'http',status:403},
    {fetch:async()=>new Response(privateText,{status:503}),code:'catalog_http_error',phase:'headers',reason:'http',status:503},
    {fetch:async()=>new Response(null,{status:302,headers:{Location:'https://secret.example/'+privateText}}),code:'catalog_redirect_rejected',phase:'headers',reason:'redirect',status:302},
    {fetch:async()=>new Response(privateText),code:'catalog_invalid_response',phase:'decode',reason:'invalid_response',status:200},
    {fetch:async()=>new Response(privateText,{status:206}),code:'catalog_invalid_response',phase:'decode',reason:'invalid_response',status:206},
    {fetch:async()=>Response.json(null),code:'catalog_invalid_response',phase:'validate',reason:'invalid_response',status:200},
    ...[['ENOTFOUND','dns'],['ERR_TLS_CERT_ALTNAME_INVALID','tls'],['ECONNRESET','connection']].map(([code,reason])=>({fetch:async()=>{throw new TypeError(privateText,{cause:Object.assign(new Error(privateText),{code})});},code:'catalog_network_error',phase:'request',reason})),
    {fetch:async()=>{throw new DOMException(privateText,'TimeoutError');},code:'catalog_timeout',phase:'request',reason:'timeout'},
    {fetch:async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException(privateText,'AbortError'));}})),code:'catalog_timeout',phase:'body',reason:'timeout'}
  ];
  for(const item of cases){
    await assert.rejects(searchBookCatalog({query:'original'},item.fetch),error=>{
      assert.equal(error.code,item.code);
      const diagnostic=catalogFailureDiagnostic(error,{phase:'search',startedAt:Date.now()});
      const {elapsed_ms,...fixed}=diagnostic;
      assert(Number.isSafeInteger(elapsed_ms)&&elapsed_ms>=0&&elapsed_ms<=180000);
      assert.deepEqual(fixed,{source:'gutendex',phase:item.phase,reason:item.reason,...(item.status?{status:item.status}:{})});
      assert(!JSON.stringify(diagnostic).includes(privateText));
      diagnostic.reason=privateText;
      assert.notEqual(catalogFailureDiagnostic(error,{phase:'search',startedAt:Date.now()}).reason,privateText,'caller cannot change internal diagnosis');
      return true;
    });
  }
  assert.deepEqual(catalogFailureDiagnostic(new Error(privateText),{phase:'grant_before',startedAt:Date.now()+1000}),{source:'service',phase:'grant_before',reason:'service_error',elapsed_ms:0});
  assert.deepEqual((await searchBookCatalog({query:'original'},async()=>Response.json({results:[null,{},...catalog.results]}))).items.length,1,'malformed individual metadata rows cannot masquerade as a connection failure');
});

test('catalog accepts 6 MiB and exactly 10 MiB, rejects oversized declared and streamed bodies',async()=>{
  assert.equal(CATALOG_LIMITS.maxBytes,10*1024*1024);
  const start='*** START OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***\n';
  const end='\n*** END OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***';
  for(const size of [6*1024*1024,CATALOG_LIMITS.maxBytes]){
    const body=start+'x'.repeat(size-start.length-end.length)+end;
    const bytes=await downloadCatalogBook(candidate,async()=>new Response(body,{headers:{'content-type':'text/plain'}}));
    assert.equal(bytes.byteLength,size);
  }
  for(const declared of [true,false]){
    const body=new Uint8Array(CATALOG_LIMITS.maxBytes+1);
    const headers={'content-type':'text/plain',...(declared?{'content-length':String(body.length)}:{})};
    await assert.rejects(downloadCatalogBook(candidate,async()=>new Response(body,{headers})),error=>error.status===413&&error.code==='catalog_file_too_large');
  }
});

test('catalog model tools are opt-in, disabled for probes and bounded to one import per turn',async()=>{
  for(const probe of [true,false])await runModel({env,payload,probe,...(probe?{searchBooks:()=>{},importBook:()=>{}}:{}),fetchImpl:async(url,init)=>{assert.equal(JSON.parse(init.body).tools,undefined);return Response.json({choices:[{message:{content:'没有搜书。'}}]});}});
  let step=0,imports=0;
  const reply=await runModel({env,payload,searchBooks:async()=>catalog,importBook:async()=>{imports++;return {book_id:'saved'};},fetchImpl:async()=>Response.json({choices:[{message:step++===0?{tool_calls:[{id:'s',type:'function',function:{name:'search_books',arguments:'{"query":"海边"}'}}]}:step===2?{tool_calls:[{id:'i',type:'function',function:{name:'import_book',arguments:'{"candidate_id":"gutenberg_123"}'}}]}:{content:'已导入。'}}]})});
  assert.equal(reply,'已导入。');assert.equal(imports,1);
  await assert.rejects(runModel({env,payload,searchBooks:async()=>{},importBook:async()=>{throw Error('must not run');},fetchImpl:async()=>Response.json({choices:[{message:{tool_calls:[{id:'i',type:'function',function:{name:'import_book',arguments:'{"candidate_id":"gutenberg_123","url":"http://localhost"}'}}]}}]})}),/Invalid catalog tool input/);
});

test('workerd catalog keeps frozen originals, tenant isolation, permissions, retries and daily limits',async()=>{
  let searches=0,downloads=0,failDownload=true;
  const bindings={READER_TOKEN:'fixture',SESSION_SECRET:'catalog-fixture-secret',AI_MODE:'mock'};
  const mf=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==='gutendex.com'){searches++;return MFResponse.json(catalog);}
    assert.equal(url.hostname,'gutenberg.pglaf.org');downloads++;
    return failDownload?new MFResponse('not now',{status:503}):new MFResponse(content,{headers:{'content-type':'text/plain'}});
  }});
  try{
    const req=async(path,body,owner='alice',extra={})=>mf.dispatchFetch('https://reading.test'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner}),...extra},body:JSON.stringify(body)});
    const usage=async(owner='alice')=>(await(await mf.dispatchFetch('https://reading.test/api/book-catalog/usage',{headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner})}})).json());
    const emptyUsage=await usage();assert.deepEqual(emptyUsage.searches,{used:0,limit:10,remaining:10});assert.deepEqual(emptyUsage.imports,{used:0,limit:3,remaining:3});
    assert.equal((await mf.dispatchFetch('https://reading.test/api/book-catalog/usage')).status,401);
    assert.equal((await req('/api/book-catalog/usage',{})).status,405);
    assert.deepEqual(await usage(),emptyUsage,'reading remaining allowances does not consume them');
    assert.equal((await mf.dispatchFetch('https://reading.test/api/book-catalog/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"query":"海边"}'})).status,401);
    assert.equal((await req('/api/book-catalog/search',{query:'海边'},'alice',{Origin:'https://evil.test'})).status,403);
    assert.equal((await req('/api/book-catalog/import',{candidate_id:'gutenberg_123'})).status,409);
    assert.equal((await req('/api/book-catalog/search',{query:'海边'})).status,200);
    assert.equal((await req('/api/book-catalog/search',{query:'海边'})).status,200);assert.equal(searches,1,'repeat query is cached');
    assert.deepEqual((await usage()).searches,{used:1,limit:10,remaining:9});
    assert.equal((await req('/api/book-catalog/import',{candidate_id:'gutenberg_123'},'bob')).status,409);
    assert.equal((await req('/api/book-catalog/import',{candidate_id:'gutenberg_123',owner_id:'bob'})).status,400);
    assert.equal((await req('/api/book-catalog/import',{candidate_id:'gutenberg_123'})).status,503);
    assert.deepEqual((await usage()).imports,{used:1,limit:3,remaining:2},'failed outbound download is still counted');
    assert.deepEqual((await usage('bob')).imports,{used:0,limit:3,remaining:3},'other owners cannot see or consume this owner allowance');
    const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
    assert.equal((await stub.call('alice','list',{kind:'book'})).value.items.length,0,'failed download stays hidden');
    failDownload=false;
    const imported=await req('/api/book-catalog/import',{candidate_id:'gutenberg_123'});assert.equal(imported.status,200,await imported.clone().text());const saved=await imported.json();
    assert.equal((await req('/api/book-catalog/import',{candidate_id:'gutenberg_123'})).status,200);assert.equal(downloads,2,'successful retry has no duplicate download');
    assert.deepEqual((await usage()).imports,{used:2,limit:3,remaining:1},'duplicate successful import is not another download attempt');
    const books=(await stub.call('alice','list',{kind:'book'})).value.items;assert.equal(books.length,1);assert.equal(books[0].current_version,1);
    const token=await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:'alice'});
    const original=await mf.dispatchFetch('https://reading.test/api/reading/documents/'+saved.document_id+'/text',{headers:{Authorization:'Bearer '+token}});assert.equal(await original.text(),content);
    assert.equal((await stub.call('bob','searchCatalog',{query:'海边'})).status,403);
    for(let i=0;i<9;i++)assert.equal((await req('/api/book-catalog/search',{query:'另一本'+i})).status,200);
    assert.equal((await req('/api/book-catalog/search',{query:'超限'})).status,429);assert.equal(searches,10);
    assert.deepEqual((await usage()).searches,{used:10,limit:10,remaining:0},'exhausted usage remains readable after rejected work');
    const opening={book_id:saved.book_id,thread_id:'t',turn_id:'u',delivery_id:'d',opening_message_id:'m',title:'搜书',opening:'找书'};
    assert((await stub.call('alice','createThread',opening)).ok);assert((await stub.call('alice','claimDispatch',{turn_id:'u'})).ok);
    assert.equal((await stub.call('alice','modelSearchCatalog',{turn_id:'u',query:'海边'})).status,403,'model requires independent opt-in');
    assert((await stub.call('alice','putAISettings',{revision:0,iv:'fixture',cipher:'fixture',tested_at:'fixture',public:{allow_catalog:true}})).ok);
    assert.equal((await stub.call('alice','modelImportCatalog',{turn_id:'u',candidate_id:'gutenberg_123'})).ok,true);
    assert.equal((await stub.call('alice','modelImportCatalog',{turn_id:'u',candidate_id:'gutenberg_123',owner_id:'bob'})).status,400);
  }finally{await mf.dispose();}
});

test('scheduled model discussions do not receive search or import tools even when enabled',async()=>{
  const turnPayload={...payload,thread_id:'t',turn_id:'u',delivery_id:'d'};
  const stub={call:async(owner,op)=>({ok:true,value:op==='prepareDispatch'?{payload:turnPayload,turn:{delivery_id:'d'}}:op==='claimDispatch'?{acquired:true}:op==='get'?{scheduled:true}:op==='modelHistory'?[]:null})};
  const result=await dispatchReadingTurn({...env,AI_MODE:'model',MODEL_ALLOW_CATALOG:'true'},stub,'u','alice','https://reading.test',async(url,init)=>{assert.equal(JSON.parse(init.body).tools,undefined);return Response.json({choices:[{message:{content:'只讨论已有书籍。'}}]});});
  assert.equal(result.status,'completed');
});

test('public catalog respects approval, book/storage quotas and suspension without downloading extra books',async()=>{
  let downloads=0;
  const bindings={INTERNAL_KEY:'catalog-internal-fixture',OWNER_KEY:'catalog-owner-fixture',SESSION_SECRET:'catalog-session-fixture',PUBLIC_SERVICE:'true',AI_MODE:'mock'};
  const mf=new Miniflare({modules:true,scriptPath:'dist/public-worker.mjs',compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{REGISTRY:{className:'Registry',useSQLite:true},READING_LIBRARY:{className:'HostedReadingLibraryDO',useSQLite:true}},bindings,outboundService:async request=>{
    if(new URL(request.url).hostname==='gutendex.com')return MFResponse.json(catalog);
    downloads++;return new MFResponse(content,{headers:{'content-type':'text/plain'}});
  }});
  try{
    const request=(path,body,cookie='')=>mf.dispatchFetch('https://reading.test'+path,{method:body?'POST':'GET',headers:{Origin:'https://reading.test',Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const cookie=r=>r.headers.get('set-cookie').split(';')[0];
    const admin=cookie(await request('/service/api/owner-login',{key:bindings.OWNER_KEY}));
    await request('/service/api/owner/policy',initialPolicy,admin);
    const response=await request('/service/api/register',{username:'alice',password:'fixture-password-123',name:'原创读者',contact:'fixture@example.test',reason:'测试搜书'}),session=cookie(response);let user=(await response.json()).user;
    assert.equal((await request('/api/book-catalog/search',{query:'海边'},session)).status,403);
    const review=async quota=>{const r=await request('/service/api/owner/review',{id:user.id,expectedRevision:user.revision,status:'active',quota,note:'fixture'},admin);assert.equal(r.status,200,await r.clone().text());user=(await r.json()).user;};
    const quota={...suggestedQuota,books:1,bytes:20000};await review(quota);
    assert.equal((await request('/api/book-catalog/search',{query:'海边'},session)).status,200);
    await request('/api/reading/books',{book_id:'already_full',title:'已有书籍'},session);
    assert.equal((await request('/api/book-catalog/import',{candidate_id:'gutenberg_123'},session)).status,429);assert.equal(downloads,0);
    await review({...quota,books:2});
    assert.equal((await request('/api/book-catalog/import',{candidate_id:'gutenberg_123'},session)).status,200);
    assert.equal((await request('/api/book-catalog/import',{candidate_id:'gutenberg_123'},session)).status,200);assert.equal(downloads,1);
    const usage=await request('/api/public-usage',null,session);assert((await usage.json()).value.bytes<20000);
    await request('/service/api/owner/review',{id:user.id,expectedRevision:user.revision,status:'suspended',quota:{...quota,books:2},note:'fixture'},admin);
    assert.equal((await request('/api/book-catalog/search',{query:'海边'},session)).status,403);
  }finally{await mf.dispose();}
});
