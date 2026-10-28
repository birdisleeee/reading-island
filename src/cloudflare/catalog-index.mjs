import {readBody,requireValue} from './validation.mjs';

export const CATALOG_INDEX_PATH='/reading-island/assets/catalog-index.tsv';
const loaded=new WeakMap();
// Common translated titles identify the original work, never an invented translation.
const aliases=[['傲慢与偏见','pride and prejudice'],['理智与情感','sense and sensibility'],['呼啸山庄','wuthering heights'],['远大前程','great expectations'],['双城记','a tale of two cities'],['简爱','jane eyre'],['面纱','the painted veil'],['毛姆','maugham'],['奥斯汀','austen'],['狄更斯','dickens']];
const chineseTitles=[['红楼梦','紅樓夢'],['西游记','西遊記'],['水浒传','水滸傳'],['三国演义','三國志演義'],['论语','論語'],['道德经','道德經']];
const fold=value=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const cleanQuery=value=>fold(value).replace(/[《》“”‘’'"，。！？,.!?]/g,' ').replace(/\s+/g,' ').trim();
export async function loadCatalogIndex(assets){
  if(!assets?.fetch)return null;
  if(!loaded.has(assets)){
    const promise=(async()=>{
      const response=await assets.fetch(new Request('https://reading-assets.invalid'+CATALOG_INDEX_PATH,{signal:AbortSignal.timeout(5000)}));
      if(response.status===404)return null;
      if(!response.ok)throw Error('catalog_index_unavailable');
      const bytes=await readBody(response,16*1024*1024),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),end=text.indexOf('\n');
      if(end<0||end>4096)throw Error('catalog_index_invalid');
      const metadata=JSON.parse(text.slice(0,end));
      if(metadata.schema!==1||!/^\d{4}-\d{2}-\d{2}$/.test(metadata.snapshot)||!Number.isSafeInteger(metadata.records)||metadata.records<1||metadata.records>200000)throw Error('catalog_index_invalid');
      let count=0;const ids=new Set();
      for(let start=end+1;start<text.length;){
        const lineEnd=text.indexOf('\n',start),line=text.slice(start,lineEnd<0?undefined:lineEnd);start=lineEnd<0?text.length:lineEnd+1;
        const fields=line.split('\t'),id=Number(fields[0]);
        if(fields.length!==4||!/^\d+$/.test(fields[0])||!Number.isSafeInteger(id)||id<1||id>=10000000||ids.has(id)||!fields[1]||fields[1].length>300||fields[2].length>180||! /^[a-z]{2,3}(?:,[a-z]{2,3})*$/.test(fields[3])||/[\u0000-\u001f\u007f]/.test(line.replaceAll('\t','')))throw Error('catalog_index_invalid');
        ids.add(id);count++;
      }
      if(count!==metadata.records)throw Error('catalog_index_invalid');
      return {metadata,text,start:end+1};
    })();
    loaded.set(assets,promise);promise.catch(()=>{if(loaded.get(assets)===promise)loaded.delete(assets);});
  }
  return loaded.get(assets);
}
export function searchCatalogIndex(index,{query,language=''}){
  const original=cleanQuery(query);let expanded=original,foreignTitle=false;
  for(const [alias,title] of aliases)if(expanded.includes(alias)){expanded=expanded.replaceAll(alias,title);foreignTitle=true;}
  for(const [alias,title] of chineseTitles)expanded=expanded.replaceAll(alias,title);
  const tokens=expanded.split(/\s+/).filter(Boolean),matches=[];
  requireValue(tokens.length>0,'invalid_catalog_input');
  for(let start=index.start;start<index.text.length;){
    const end=index.text.indexOf('\n',start),line=index.text.slice(start,end<0?undefined:end);start=end<0?index.text.length:end+1;
    const first=line.indexOf('\t'),second=line.indexOf('\t',first+1),third=line.indexOf('\t',second+1);if(first<1||second<0||third<0)continue;
    const languages=line.slice(third+1).split(',');if(language&&!languages.includes(language))continue;
    const searchable=fold(line.slice(first+1,third));if(!tokens.every(token=>searchable.includes(token)))continue;
    const id=Number(line.slice(0,first));if(!Number.isSafeInteger(id)||id<1||id>=10000000)continue;
    const title=line.slice(first+1,second),author=line.slice(second+1,third),normalizedTitle=cleanQuery(title);
    const score=normalizedTitle===expanded?0:normalizedTitle.startsWith(expanded)?1:normalizedTitle.includes(expanded)?2:3;
    matches.push({id,title,author,languages,score});matches.sort((a,b)=>a.score-b.score||a.id-b.id);if(matches.length>6)matches.pop();
  }
  const items=matches.map(({id,title,author,languages})=>({candidate_id:'gutenberg_'+id,source:'Project Gutenberg',source_id:id,title,author,languages,format:'txt',source_url:'https://www.gutenberg.org/ebooks/'+id,metadata_snapshot:true,requires_verification:true}));
  return {query,language,items,catalog_snapshot:index.metadata.snapshot,notice:items.length?'来自公开书目快照；请核对语言，导入时验证所选版本与 UTF-8 全文。':foreignTitle&&language==='zh'?'此中文书名可对应外文版本；当前中文筛选未找到版本，可切换全部语言查看。':'公开书目中未匹配到版本，可调整书名、作者或语言，也可以上传已有电子书。'};
}
