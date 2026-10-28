import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Response as MFResponse} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
import {readFile} from 'node:fs/promises';
import {loadCatalogIndex,searchCatalogIndex,CATALOG_INDEX_PATH} from '../src/cloudflare/catalog-index.mjs';
import {searchBookCatalog,downloadCatalogBook,catalogFailureDiagnostic} from '../src/cloudflare/book-catalog.mjs';

const rows=[
  [64682,'The Painted Veil','Maugham, W. Somerset (William Somerset), 1874-1965','en'],
  [1342,'Pride and Prejudice','Austen, Jane, 1775-1817','en'],
  [999991,'原创海边测试书','原创作者','zh'],
  [999992,'Études au café','Auteur Émile','fr']
];
const indexText=(records=rows,metadata={})=>JSON.stringify({schema:1,snapshot:'2026-10-25',records:records.length,fields:['id','title','author','languages'],...metadata})+'\n'+records.map(row=>row.join('\t')).join('\n')+'\n';
const assetsFor=value=>({fetch:async()=>new Response(value)});
const forbidExternal=async()=>{throw Error('Unexpected external request in snapshot search');};
const candidate={candidate_id:'gutenberg_64682',source_id:64682,metadata_snapshot:true,requires_verification:true};
const original='*** START OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***\n'+'原创快照导入测试。'.repeat(40)+'\n*** END OF THE PROJECT GUTENBERG EBOOK ORIGINAL FIXTURE ***';
function ebook({id=64682,rights='Public domain in the USA.',format='text/plain; charset=utf-8',extra='',hasFormat=true}={}){
  return `<pgterms:ebook rdf:about="ebooks/${id}"><dcterms:rights>${rights}</dcterms:rights>${hasFormat?`<dcterms:hasFormat><pgterms:file rdf:about="https://www.gutenberg.org/ebooks/${id}.txt.utf-8"><dcterms:format><rdf:Description><rdf:value rdf:datatype="http://purl.org/dc/terms/IMT">${format}</rdf:value></rdf:Description></dcterms:format></pgterms:file></dcterms:hasFormat>`:''}${extra}</pgterms:ebook>`;
}
const rdf=(body=ebook())=>`<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:pgterms="http://www.gutenberg.org/2009/pgterms/" xmlns:dcterms="http://purl.org/dc/terms/">${body}</rdf:RDF>`;

test('bundled public metadata is complete and common simplified titles match their cataloged Chinese editions',async()=>{
  const index=await loadCatalogIndex(assetsFor(await readFile(new URL('../catalog/index.tsv',import.meta.url))));
  assert.equal(index.metadata.records,78423);
  assert.deepEqual(searchCatalogIndex(index,{query:'面纱'}).items.map(item=>item.source_id),[64682]);
  for(const [query,id] of [['红楼梦',24264],['西游记',23962],['水浒传',23863],['三国演义',23950],['论语',23839],['道德经',7337]]){
    const result=searchCatalogIndex(index,{query,language:'zh'});assert(result.items.some(item=>item.source_id===id));assert(result.items.every(item=>item.languages.includes('zh')));
  }
});

test('snapshot Chinese aliases identify the original without inventing a Chinese edition or calling a search service',async()=>{
  const assets=assetsFor(indexText());
  const result=await searchBookCatalog({query:'《面纱》'},forbidExternal,assets);
  assert.equal(result.catalog_snapshot,'2026-10-25');
  assert.deepEqual(result.items.map(item=>[item.candidate_id,item.title,item.languages]),[['gutenberg_64682','The Painted Veil',['en']]]);
  assert.equal(result.items[0].metadata_snapshot,true);assert.equal(result.items[0].requires_verification,true);
  assert.equal(result.items[0].source_url,'https://www.gutenberg.org/ebooks/64682');
  const chinese=await searchBookCatalog({query:'面纱',language:'zh'},forbidExternal,assets);
  assert.deepEqual(chinese.items,[]);assert.match(chinese.notice,/中文筛选.*切换全部语言/);
  assert.deepEqual((await searchBookCatalog({query:'原创',language:'zh'},forbidExternal,assets)).items.map(item=>item.source_id),[999991]);
});

test('snapshot matching normalizes case and accents, requires every query term and retains title substring search',async()=>{
  const index=await loadCatalogIndex(assetsFor(indexText()));
  for(const query of ['THE PAINTED VEIL','paint maugham','毛姆 面纱'])assert.deepEqual(searchCatalogIndex(index,{query}).items.map(item=>item.source_id),[64682]);
  for(const query of ['etudes emile','ÉTUDES CAFÉ'])assert.deepEqual(searchCatalogIndex(index,{query}).items.map(item=>item.source_id),[999992]);
  assert.deepEqual(searchCatalogIndex(index,{query:'paint austen'}).items,[]);
  assert.deepEqual(searchCatalogIndex(index,{query:'paint',language:'zh'}).items,[]);
  const ranked=await loadCatalogIndex(assetsFor(indexText([[9,'Other paint','Writer','en'],[8,'Paint extended','Writer','en'],[7,'Paint','Writer','en'],...[6,5,4,3,2,1].map(id=>[id,'Another paint '+id,'Writer','en'])])));
  const result=searchCatalogIndex(ranked,{query:'paint'});
  assert.equal(result.items.length,6);assert.deepEqual(result.items.slice(0,2).map(item=>item.source_id),[7,8]);
});

test('punctuation-only snapshot queries are rejected instead of returning arbitrary titles',async()=>{
  const assets=assetsFor(indexText());
  for(const query of ['!!','《》',' ， 。 '])await assert.rejects(searchBookCatalog({query},forbidExternal,assets),error=>error.code==='invalid_catalog_input'&&error.status===400);
});

test('snapshot loading is cached per ASSETS binding, including concurrent callers, with no shared tenant data',async()=>{
  let calls=0;const assets={fetch:async request=>{calls++;assert.equal(new URL(request.url).pathname,CATALOG_INDEX_PATH);assert(request.signal);await Promise.resolve();return new Response(indexText());}};
  const [first,second]=await Promise.all([loadCatalogIndex(assets),loadCatalogIndex(assets)]);
  assert.equal(first,second);assert.equal(await loadCatalogIndex(assets),first);assert.equal(calls,1);
  const other=await loadCatalogIndex(assetsFor(indexText([[888,'Only another binding','原创','zh']])));
  assert.deepEqual(searchCatalogIndex(other,{query:'another'}).items.map(item=>item.source_id),[888]);
  assert.deepEqual(searchCatalogIndex(first,{query:'another'}).items,[]);
});

test('an absent snapshot falls back explicitly to the existing fixed-host search while other failures do not',async()=>{
  let assetCalls=0,externalCalls=0;const assets={fetch:async()=>{assetCalls++;return new Response(null,{status:404});}};
  const external=async url=>{externalCalls++;const parsed=new URL(url);assert.equal(parsed.origin,'https://gutendex.com');assert.equal(parsed.searchParams.get('search'),'原创书');assert.equal(parsed.searchParams.get('languages'),'zh');return Response.json({results:[]});};
  for(let i=0;i<2;i++)assert.deepEqual((await searchBookCatalog({query:'原创书',language:'zh'},external,assets)).items,[]);
  assert.equal(assetCalls,1);assert.equal(externalCalls,2);
  assert.equal(await loadCatalogIndex(undefined),null);
  assert.deepEqual((await searchBookCatalog({query:'原创书',language:'zh'},external)).items,[]);
});

test('broken snapshot headers, UTF-8 and unavailable assets fail safely and permit a later explicit load',async()=>{
  const privateMarker='private-index-error-do-not-return';
  const bad=[new Response(privateMarker,{status:503}),new Response('{broken\n1\tTitle\tWriter\ten\n'),new Response(indexText(rows,{schema:2})),new Response(indexText(rows,{records:0})),new Response(indexText(rows,{records:200001})),new Response(indexText(rows,{snapshot:'not-a-day'})),new Response(new Uint8Array([0xc3,0x28]))];
  for(const response of bad){
    await assert.rejects(searchBookCatalog({query:'面纱'},forbidExternal,{fetch:async()=>response}),error=>{
      assert.equal(error.code,'catalog_service_error');assert.equal(error.status,503);
      const diagnostic=catalogFailureDiagnostic(error,{phase:'search',startedAt:Date.now()});
      assert.equal(diagnostic.source,'service');assert.equal(diagnostic.reason,'invalid_response');assert(!JSON.stringify(diagnostic).includes(privateMarker));return true;
    });
  }
  let calls=0;const assets={fetch:async()=>{calls++;return calls===1?new Response('broken'):new Response(indexText());}};
  await assert.rejects(loadCatalogIndex(assets));assert(await loadCatalogIndex(assets));assert.equal(calls,2,'failed load must not poison every later explicit request');
});

test('snapshot row corruption is rejected before it can masquerade as a successful empty search',async()=>{
  const bad=[
    indexText([[1,'Title','Author']]),indexText([[1,'Title','Author','en','extra']]),
    indexText([[0,'Title','Author','en']]),indexText([['not-id','Title','Author','en']]),indexText([[1,'Title','Author','english']]),
    indexText([[1,'Title','Author','en'],[1,'Other','Author','zh']]),indexText(rows,{records:rows.length+1})
  ];
  for(const value of bad)await assert.rejects(searchBookCatalog({query:'Title'},forbidExternal,assetsFor(value)),error=>error.code==='catalog_service_error');
});

test('snapshot imports verify the selected RDF record before one bounded UTF-8 download and ignore supplied URLs',async()=>{
  const urls=[];const bytes=await downloadCatalogBook({...candidate,source_url:'http://127.0.0.1/private'},async(url,options)=>{
    urls.push(url);assert.equal(options.redirect,'manual');assert(options.signal);
    return urls.length===1?new Response(rdf(),{headers:{'Content-Type':'application/rdf+xml'}}):new Response(original,{headers:{'Content-Type':'text/plain; charset=UTF-8'}});
  });
  assert.deepEqual(urls,['https://gutenberg.pglaf.org/cache/epub/64682/pg64682.rdf','https://gutenberg.pglaf.org/cache/epub/64682/pg64682.txt']);
  assert.equal(new TextDecoder().decode(bytes),original);
  await assert.rejects(downloadCatalogBook({...candidate,source_id:12},forbidExternal),error=>error.code==='invalid_catalog_candidate');
});

test('snapshot RDF rights, selected ID and format must all belong to the selected book, with no download on rejection',async()=>{
  const cases=[
    ebook({id:123}),ebook({rights:'Copyrighted.'}),ebook({format:'text/plain; charset=iso-8859-1'}),
    ebook({rights:'Copyrighted.',hasFormat:false})+ebook({id:123}),
    ebook({hasFormat:false,extra:'<dcterms:description><rdf:value>text/plain; charset=utf-8</rdf:value></dcterms:description>'}),
    ebook({format:'application/epub+zip'})+ebook({id:123})
  ];
  for(const body of cases){let calls=0;await assert.rejects(downloadCatalogBook(candidate,async()=>{calls++;return new Response(rdf(body));}),error=>error.status===422&&error.code==='catalog_version_unavailable');assert.equal(calls,1);}
});

test('invalid or oversized RDF retains bounded fixed diagnostics and never requests the book body',async()=>{
  for(const item of [{response:()=>new Response(new Uint8Array([0xc3,0x28])),code:'catalog_invalid_response',phase:'decode',status:503},{response:()=>new Response('<!DOCTYPE rdf:RDF [<!ENTITY hidden SYSTEM "http://127.0.0.1/private">]>'+rdf()),code:'catalog_invalid_response',phase:'decode',status:503},{response:()=>new Response('x',{headers:{'Content-Length':String(256*1024+1)}}),code:'catalog_file_too_large',phase:'headers',status:413}]){
    let calls=0;await assert.rejects(downloadCatalogBook(candidate,async()=>{calls++;return item.response();}),error=>{
      assert.equal(error.code,item.code);assert.equal(error.status,item.status);
      const detail=catalogFailureDiagnostic(error,{phase:'import',startedAt:Date.now()});assert.equal(detail.source,'gutenberg');assert.equal(detail.phase,item.phase);return true;
    });assert.equal(calls,1);
  }
});

test('ASSETS-backed owner DO searches avoid upstream search, preserve cache/quota isolation and import idempotently',async()=>{
  const built=await build({entryPoints:['src/cloudflare/entry.mjs'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
  let assetCalls=0;const upstream=[];const secret='catalog-index-integration-fixture';
  const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings:{SESSION_SECRET:secret,AI_MODE:'mock'},serviceBindings:{ASSETS:async request=>{assetCalls++;assert.equal(new URL(request.url).pathname,CATALOG_INDEX_PATH);return new MFResponse(indexText());}},outboundService:async request=>{
    const url=new URL(request.url);upstream.push(url.href);assert.equal(url.hostname,'gutenberg.pglaf.org');
    return new MFResponse(url.pathname.endsWith('.rdf')?rdf():original,{headers:{'Content-Type':url.pathname.endsWith('.rdf')?'application/rdf+xml':'text/plain'}});
  }});
  try{
    const request=async(owner,path,body)=>mf.dispatchFetch('https://reading.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+await issueToken(secret,{purpose:'session',user_id:owner}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const usage=async owner=>(await(await request(owner,'/api/book-catalog/usage')).json());
    const search=await request('alice','/api/book-catalog/search',{query:'面纱'});assert.equal(search.status,200,await search.clone().text());assert.equal((await search.json()).items[0].source_id,64682);
    const cached=await request('alice','/api/book-catalog/search',{query:'面纱'});assert.equal((await cached.json()).cached,true);
    assert.equal(assetCalls,1);assert.deepEqual(upstream,[]);assert.equal((await usage('alice')).searches.used,1);assert.equal((await usage('bob')).searches.used,0);
    assert.equal((await request('bob','/api/book-catalog/import',{candidate_id:candidate.candidate_id})).status,409);assert.deepEqual(upstream,[]);
    const imported=await request('alice','/api/book-catalog/import',{candidate_id:candidate.candidate_id});assert.equal(imported.status,200,await imported.clone().text());
    const duplicate=await request('alice','/api/book-catalog/import',{candidate_id:candidate.candidate_id});assert.equal((await duplicate.json()).duplicate,true);
    assert.equal(upstream.length,2);assert.equal((await usage('alice')).imports.used,1,'RDF plus TXT are one selected import attempt');assert.equal((await usage('bob')).imports.used,0);
    const zh=await request('alice','/api/book-catalog/search',{query:'面纱',language:'zh'});assert.deepEqual((await zh.json()).items,[]);assert.equal((await usage('alice')).searches.used,2);
  }finally{await mf.dispose();}
});
