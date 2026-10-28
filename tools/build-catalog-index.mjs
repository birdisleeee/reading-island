import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';

export const CATALOG_SOURCE='https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';
const MAX_INDEX_BYTES=16*1024*1024;

// RFC 4180-style records: quoted commas, quotes and newlines stay in one field.
export function* parseCatalogCsv(input){
  let row=[],value='',quoted=false,closed=false;
  const source=input.replace(/^\uFEFF/,'');
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quoted){
      if(char==='"'){
        if(source[i+1]==='"'){value+='"';i++;}
        else{quoted=false;closed=true;}
      }else value+=char;
      continue;
    }
    if(char===','){row.push(value);value='';closed=false;continue;}
    if(char==='\r'||char==='\n'){
      if(char==='\r'&&source[i+1]==='\n')i++;
      row.push(value);yield row;row=[];value='';closed=false;continue;
    }
    if(closed)throw Error('Unexpected data after a quoted CSV field');
    if(char==='"'){
      if(value.length)throw Error('Unexpected quote in an unquoted CSV field');
      quoted=true;
    }else value+=char;
  }
  if(quoted)throw Error('Unterminated quoted CSV field');
  if(row.length||value.length||closed){row.push(value);yield row;}
}

function field(value,max){
  let result=String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/gu,' ').trim().slice(0,max);
  if(/[\ud800-\udbff]$/.test(result))result=result.slice(0,-1);
  return result;
}

export function buildCatalogIndex(bytes,{snapshot,source=CATALOG_SOURCE}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(snapshot||'')||new Date(snapshot+'T00:00:00Z').toISOString().slice(0,10)!==snapshot)throw Error('Supply a valid --snapshot YYYY-MM-DD from the source snapshot');
  if(!['https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv','https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv'].includes(source))throw Error('Catalog source must be the official CSV or its listed mirror');
  const rows=parseCatalogCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),first=rows.next();
  if(first.done)throw Error('Empty CSV');
  const columns=first.value,required=['Text#','Type','Title','Authors','Language'];
  if(required.some(name=>!columns.includes(name)))throw Error('CSV does not contain the expected Project Gutenberg columns');
  const index=Object.fromEntries(required.map(name=>[name,columns.indexOf(name)])),records=[],seen=new Set();let sourceRecords=0;
  for(const row of rows){
    if(row.length===1&&!row[0])continue;
    sourceRecords++;
    if(row.length!==columns.length)throw Error('CSV row has an unexpected number of fields');
    if(row[index.Type].trim()!=='Text')continue;
    const id=Number(row[index['Text#']]);
    if(!/^\d+$/.test(row[index['Text#']])||!Number.isSafeInteger(id)||id<1||id>=10000000||seen.has(id))throw Error('CSV contains an invalid or duplicate text ID');
    seen.add(id);
    const title=field(row[index.Title],300),author=field(row[index.Authors],180);
    const languages=[...new Set(row[index.Language].split(/[;,\s]+/).filter(Boolean).map(value=>value.toLowerCase()))];
    if(!title||!languages.length||languages.some(value=>!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value)))throw Error('CSV contains invalid text metadata');
    records.push({id,title,author,languages});
  }
  if(!records.length)throw Error('CSV has no text records');
  records.sort((a,b)=>a.id-b.id);
  const metadata={schema:1,snapshot,source,source_sha256:createHash('sha256').update(bytes).digest('hex'),source_records:sourceRecords,records:records.length,fields:['id','title','author','languages'],attribution:'Project Gutenberg catalog metadata (public domain)'};
  const output=JSON.stringify(metadata)+'\n'+records.map(record=>[record.id,record.title,record.author,record.languages.join(',')].join('\t')).join('\n')+'\n';
  const size=Buffer.byteLength(output);
  if(size>MAX_INDEX_BYTES)throw Error('Compact catalog exceeds the 16 MiB runtime bound');
  return {metadata,records,output,bytes:size,sha256:createHash('sha256').update(output).digest('hex')};
}

async function main(){
  const [input,...options]=process.argv.slice(2);let snapshot,source=CATALOG_SOURCE;
  if(!input||input.startsWith('--'))throw Error('Usage: node tools/build-catalog-index.mjs /local/pg_catalog.csv --snapshot YYYY-MM-DD [--source official-csv-url]');
  for(let i=0;i<options.length;i+=2){
    if(options[i]==='--snapshot')snapshot=options[i+1];
    else if(options[i]==='--source')source=options[i+1];
    else throw Error('Unknown build-catalog-index option');
    if(!options[i+1])throw Error('Missing build-catalog-index option value');
  }
  const result=buildCatalogIndex(await readFile(input),{snapshot,source}),target=new URL('../catalog/index.tsv',import.meta.url);
  await mkdir(new URL('../catalog/',import.meta.url),{recursive:true});await writeFile(target,result.output);
  console.log(JSON.stringify({output:fileURLToPath(target),snapshot:result.metadata.snapshot,records:result.records.length,bytes:result.bytes,sha256:result.sha256,source_sha256:result.metadata.source_sha256}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
