// Cloudflare R2 binding adapter. Call only after Worker authentication and book ownership checks.
const encoder = new TextEncoder();
const id = value => { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid identity'); return value; };
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
const prefix = scope => `reading-island/v1/owners/${id(scope.owner_id)}/books/${id(scope.book_id)}/`;

function validateManifest(manifest) {
  const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (manifest.protocol !== 'reading-document-r2-v1' || manifest.offset_unit !== 'utf16-code-unit'
      || !Number.isSafeInteger(manifest.length) || manifest.length < 0 || manifest.length > 32 * 1024 * 1024
      || !Number.isSafeInteger(manifest.version) || manifest.version < 1
      || !validSha(manifest.text_sha256) || !validSha(manifest.original_sha256)
      || !Array.isArray(manifest.chunks) || manifest.chunks.length > 8400) throw new Error('Invalid document manifest');
  let end = 0;
  for (const chunk of manifest.chunks) {
    if (chunk.start !== end || !Number.isSafeInteger(chunk.end) || chunk.end <= end || chunk.end - end > 32000 || !validSha(chunk.sha256)) throw new Error('Invalid chunk manifest');
    end = chunk.end;
  }
  if (end !== manifest.length) throw new Error('Incomplete document manifest');
}

async function immutablePut(bucket,key,body,type) {
  const bytes=typeof body==='string'?encoder.encode(body):body;
  const written=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:type}});
  if (!written) {
    const existing=await bucket.get(key);
    if(!existing || await sha(await existing.arrayBuffer())!==await sha(bytes)) throw new Error('Immutable object conflict');
  }
}

export async function storeFrozenDocument(bucket,scope,doc,originalBytes) {
  const root=prefix(scope), documentId=id(doc.document_id);
  if(doc.book_id!==scope.book_id || !Number.isSafeInteger(doc.version)||doc.version<1 || typeof doc.text!=='string' || !doc.text.isWellFormed()) throw new Error('Invalid document');
  if(!(originalBytes instanceof Uint8Array)||!originalBytes.byteLength||originalBytes.byteLength>25*1024*1024||encoder.encode(doc.text).byteLength>32*1024*1024) throw new Error('Invalid document size');
  const originalSha=await sha(originalBytes),textSha=await sha(encoder.encode(doc.text));
  if(originalSha!==doc.original_sha256||textSha!==doc.text_sha256) throw new Error('Document integrity mismatch');
  const originalKey=`${root}objects/${originalSha}.original`;
  await immutablePut(bucket,originalKey,originalBytes,'application/octet-stream');
  // The human reader may fetch the canonical text as a stream; Agent reads still use ranges.
  await immutablePut(bucket,`${root}objects/${textSha}.fulltext`,doc.text,'text/plain; charset=utf-8');
  const chunks=[];
  for(let start=0;start<doc.text.length;) {
    let end=Math.min(start+32000,doc.text.length);
    if(end<doc.text.length && /[\uD800-\uDBFF]/.test(doc.text[end-1]))end--;
    const text=doc.text.slice(start,end),digest=await sha(encoder.encode(text)),key=`${root}objects/${digest}.text`;
    await immutablePut(bucket,key,text,'text/plain; charset=utf-8');
    chunks.push({start,end,sha256:digest}); start=end;
  }
  const manifest={protocol:'reading-document-r2-v1',document_id:documentId,book_id:scope.book_id,version:doc.version,text_sha256:textSha,original_sha256:originalSha,original_key:originalKey,parser_version:doc.parser_version,offset_unit:'utf16-code-unit',length:doc.text.length,chunks};
  // Publishing the manifest last prevents readers from observing incomplete uploads.
  const manifestKey=`${root}documents/${documentId}.json`;
  await immutablePut(bucket,manifestKey,JSON.stringify(manifest),'application/json');
  return {document_id:documentId,version:doc.version,text_sha256:textSha};
}

export async function readFrozenRange(bucket,scope,reference,start=0,limit=2000) {
  const root=prefix(scope), documentId=id(reference.document_id);
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<1||limit>4000)throw new Error('Invalid range');
  const object=await bucket.get(`${root}documents/${documentId}.json`);
  if(!object||object.size>2*1024*1024)throw new Error('Document unavailable');
  const manifest=JSON.parse(await object.text());
  validateManifest(manifest);
  if(manifest.document_id!==documentId||manifest.book_id!==scope.book_id||manifest.version!==reference.version||manifest.text_sha256!==reference.text_sha256||start>manifest.length)throw new Error('Frozen version mismatch');
  const requestedEnd=Math.min(manifest.length,start+limit); let text='';
  for(const chunk of manifest.chunks.filter(chunk=>chunk.end>start && chunk.start<requestedEnd)) {
    if(!/^[a-f0-9]{64}$/.test(chunk.sha256))throw new Error('Invalid chunk identity');
    const body=await bucket.get(`${root}objects/${chunk.sha256}.text`);
    if(!body||body.size>128000)throw new Error('Source chunk unavailable');
    const value=await body.text();
    if(await sha(encoder.encode(value))!==chunk.sha256||value.length!==chunk.end-chunk.start)throw new Error('Source chunk integrity mismatch');
    text+=value.slice(Math.max(0,start-chunk.start),Math.min(value.length,requestedEnd-chunk.start));
  }
  if(text.length!==requestedEnd-start)throw new Error('Incomplete source range');
  if(/^[\uDC00-\uDFFF]/.test(text))throw new Error('Range splits a character');
  if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  if(requestedEnd>start&&!text.length)throw new Error('Range too small');
  const end=start+text.length;
  return {document_id:documentId,document_version:manifest.version,start,end,text,next_start:end<manifest.length?end:null,total:manifest.length};
}
