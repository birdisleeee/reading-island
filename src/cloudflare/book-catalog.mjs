import {ReadingError,requireValue,text,readBody,readJson} from './validation.mjs';
import {loadCatalogIndex,searchCatalogIndex} from './catalog-index.mjs';
import {DOMParser} from 'linkedom';

export const CATALOG_LIMITS={searches:10,imports:3,maxBytes:10*1024*1024,results:6};
const failureDetails=new WeakMap();
const servicePhases=new Set(['grant_before','search','import','grant_after','persist']);
const elapsed=startedAt=>Number.isSafeInteger(startedAt)?Math.min(180000,Math.max(0,Date.now()-startedAt)):0;
function failure(code,source,phase,reason,startedAt,status,errorStatus){
  const error=new ReadingError(errorStatus||({catalog_file_too_large:413,catalog_invalid_file:415,catalog_incomplete_file:422}[code]||503),code);
  failureDetails.set(error,{source,phase,reason,elapsed_ms:elapsed(startedAt),...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{})});
  return error;
}
// Only fixed classifications are retained; raw exceptions can contain URLs or credentials.
export function catalogFailureDiagnostic(error,{phase,startedAt}){
  const detail=failureDetails.get(error);if(detail)return {...detail};
  return {source:'service',phase:servicePhases.has(phase)?phase:'persist',reason:error instanceof ReadingError?'rejected':'service_error',elapsed_ms:elapsed(startedAt),...(Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?{status:error.status}:{})};
}
function connectionReason(error){
  const code=error?.cause?.code||error?.code;
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'dns';
  if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_PROTOCOL_ERROR'].includes(code))return 'tls';
  return 'connection';
}
// No caller-supplied URLs, credentials, redirect destinations or full-library mirror.
async function boundedFetch(url,max,fetchImpl,timeout=20000){
  const signal=AbortSignal.timeout(timeout),startedAt=Date.now(),source=new URL(url).hostname==='gutendex.com'?'gutendex':'gutenberg';let phase='request',response;
  try{
    response=await fetchImpl(url,{redirect:'manual',signal,headers:{Accept:'application/json,text/plain', 'User-Agent':'ReadingIsland/0.5 book-import'}});
    phase='headers';
    if(!response.ok){
      void response.body?.cancel().catch(()=>{});
      throw failure(response.status===429?'catalog_rate_limited':response.status>=300&&response.status<400?'catalog_redirect_rejected':'catalog_http_error',source,phase,response.status>=300&&response.status<400?'redirect':'http',startedAt,response.status);
    }
    const length=response.headers.get('content-length');
    if(length&&Number(length)>max){void response.body?.cancel().catch(()=>{});throw failure('catalog_file_too_large',source,phase,'too_large',startedAt);}
    phase='body';
    return {bytes:await readBody(response,max),type:response.headers.get('content-type')||'',status:response.status,startedAt,source};
  }catch(error){
    if(failureDetails.has(error))throw error;
    if(error?.status===413)throw failure('catalog_file_too_large',source,phase,'too_large',startedAt);
    if(error instanceof ReadingError)throw failure('catalog_invalid_response',source,phase,'invalid_response',startedAt);
    const timeoutError=signal.aborted||['TimeoutError','AbortError'].includes(error?.name);
    throw failure(timeoutError?'catalog_timeout':'catalog_network_error',source,phase,timeoutError?'timeout':connectionReason(error),startedAt);
  }
}
export async function searchBookCatalog(input,fetchImpl=fetch,assets){
  requireValue(input&&Object.keys(input).every(k=>['query','language'].includes(k)),'invalid_catalog_input');
  const query=text(input.query,120).trim(),language=input.language||'';
  requireValue(query.length>=2&&!/[\u0000-\u001f\u007f]/.test(query)&&['','zh','en'].includes(language),'invalid_catalog_input');
  if(assets){
    const startedAt=Date.now();let index;
    try{index=await loadCatalogIndex(assets);}catch{throw failure('catalog_service_error','service','search','invalid_response',startedAt);}
    if(index)return searchCatalogIndex(index,{query,language});
  }
  const url=new URL('https://gutendex.com/books/');
  url.searchParams.set('search',query);
  if(language)url.searchParams.set('languages',language);
  const {bytes,status,startedAt,source}=await boundedFetch(url.href,1024*1024,fetchImpl);
  let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure('catalog_invalid_response',source,'decode','invalid_response',startedAt,status);}
  if(!Array.isArray(data?.results))throw failure('catalog_invalid_response',source,'validate','invalid_response',startedAt,status);
  const items=data.results.filter(book=>book&&Number.isSafeInteger(book.id)&&book.id>0&&book.id<10000000&&book.copyright===false&&typeof book.title==='string'&&Object.keys(book.formats||{}).some(type=>/^text\/plain;\s*charset=utf-8$/i.test(type)))
    .slice(0,CATALOG_LIMITS.results).map(book=>({candidate_id:'gutenberg_'+book.id,source:'Project Gutenberg',source_id:book.id,title:book.title.slice(0,300),author:(Array.isArray(book.authors)?book.authors:[]).slice(0,3).map(a=>String(a?.name||'').slice(0,60)).join('、'),languages:(Array.isArray(book.languages)?book.languages:[]).filter(v=>typeof v==='string').slice(0,4),format:'txt',source_url:'https://www.gutenberg.org/ebooks/'+book.id}));
  return {query,language,items,notice:'开放书库中的 UTF-8 全文；部分中文古籍及外文经典，不保证能找到所有书。请确认作品和版本适合你所在地区的使用条件。'};
}
export async function downloadCatalogBook(candidate,fetchImpl=fetch){
  requireValue(candidate?.candidate_id==='gutenberg_'+candidate?.source_id&&Number.isSafeInteger(candidate.source_id)&&candidate.source_id>0&&candidate.source_id<10000000,'invalid_catalog_candidate');
  if(candidate.metadata_snapshot){
    // The CSV is a discovery index. Only the chosen machine-readable record is
    // checked for rights/format before downloading; no human-page crawling.
    const url=`https://gutenberg.pglaf.org/cache/epub/${candidate.source_id}/pg${candidate.source_id}.rdf`;
    const {bytes,status,source,startedAt}=await boundedFetch(url,256*1024,fetchImpl);
    let doc;try{const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('unexpected_xml_declaration');doc=new DOMParser().parseFromString(xml,'text/xml');}catch{throw failure('catalog_invalid_response',source,'decode','invalid_response',startedAt,status);}
    const book=[...doc.getElementsByTagName('pgterms:ebook')].find(node=>node.getAttribute('rdf:about')===`ebooks/${candidate.source_id}`),id=book?.getAttribute('rdf:about'),rights=[...(book?.getElementsByTagName('dcterms:rights')||[])].map(node=>node.textContent.trim()),formats=[...(book?.getElementsByTagName('dcterms:format')||[])].flatMap(node=>[...node.getElementsByTagName('rdf:value')].map(value=>value.textContent.trim()));
    if(id!==`ebooks/${candidate.source_id}`||!rights.includes('Public domain in the USA.')||!formats.some(value=>/^text\/plain;\s*charset=utf-8$/i.test(value)))throw failure('catalog_version_unavailable',source,'validate','invalid_file',startedAt,status,422);
  }
  // Officially listed mirror with generated files; avoid crawling the human-facing site.
  const id=candidate.source_id,url=`https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.txt`;
  const {bytes,type,status,startedAt,source}=await boundedFetch(url,CATALOG_LIMITS.maxBytes,fetchImpl,60000);
  if(!/^text\/plain(?:;|$)/i.test(type))throw failure('catalog_invalid_file',source,'validate','invalid_file',startedAt,status);
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw failure('catalog_invalid_file',source,'decode','invalid_file',startedAt,status,422);}
  if(!(content.length>100&&/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.test(content)&&/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.test(content)))throw failure('catalog_incomplete_file',source,'validate','incomplete_file',startedAt,status);
  return bytes;
}

export async function handleBookCatalog(request,env,principal){
  const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  try{
    requireValue(principal?.role==='reader','unauthorized',401);
    const url=new URL(request.url),origin=request.headers.get('origin');
    requireValue((!origin||origin===url.origin)&&request.headers.get('sec-fetch-site')!=='cross-site','cross_origin_forbidden',403);
    const jobs=url.pathname==='/api/book-catalog/jobs',usage=url.pathname==='/api/book-catalog/usage';
    requireValue(usage?request.method==='GET':request.method==='POST'||jobs&&request.method==='GET','method_not_allowed',405);
    const operation=usage?'getCatalogUsage':jobs?(request.method==='GET'?'listCatalogJobs':'queueCatalogJob'):{'/api/book-catalog/search':'searchCatalog','/api/book-catalog/import':'importCatalog'}[url.pathname];
    requireValue(operation,'not_found',404);
    const input=request.method==='GET'?{}:await readJson(request);
    const result=await env.READING_LIBRARY.getByName('reading-island:v1:owner:'+principal.user_id).call(principal.user_id,operation,input);
    return result.ok?json(result.value):json({error:result.error},result.status);
  }catch(error){return json({error:error instanceof ReadingError?error.code:'catalog_service_error'},error.status||503);}
}
