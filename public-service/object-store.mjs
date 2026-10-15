// R2-shaped adapter for the small public service. Each owner stores immutable binary
// chunks in their own SQLite DO; no extra storage product needs activation.
export class SqlObjectStore {
 constructor(storage){
  this.storage=storage;
  storage.sql.exec('CREATE TABLE IF NOT EXISTS hosted_files (key TEXT PRIMARY KEY,size INTEGER NOT NULL,type TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_chunks (key TEXT NOT NULL,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(key,part))');
 }
 async put(key,body,options={}){
  const bytes=typeof body==='string'?new TextEncoder().encode(body):new Uint8Array(body);
  return this.storage.transactionSync(()=>{
   const old=this.storage.sql.exec('SELECT size,type FROM hosted_files WHERE key=?',key).toArray()[0];
   if(old&&options.onlyIf?.etagDoesNotMatch==='*')return null;
   if(old)throw Error('Immutable storage only');
   for(let at=0,part=0;at<bytes.byteLength;at+=256*1024,part++)this.storage.sql.exec('INSERT INTO hosted_chunks(key,part,bytes) VALUES(?,?,?)',key,part,bytes.slice(at,at+256*1024));
   this.storage.sql.exec('INSERT INTO hosted_files(key,size,type) VALUES(?,?,?)',key,bytes.byteLength,options.httpMetadata?.contentType||'application/octet-stream');
   return {key,size:bytes.byteLength};
  });
 }
 async get(key){
  const meta=this.storage.sql.exec('SELECT size,type FROM hosted_files WHERE key=?',key).toArray()[0];
  if(!meta)return null;
  const bytes=new Uint8Array(meta.size);let at=0;
  for(const chunk of this.storage.sql.exec('SELECT bytes FROM hosted_chunks WHERE key=? ORDER BY part',key)){
   const value=new Uint8Array(chunk.bytes);bytes.set(value,at);at+=value.byteLength;
  }
  if(at!==bytes.byteLength)throw Error('Incomplete immutable object');
  return {size:meta.size,body:bytes,httpMetadata:{contentType:meta.type},arrayBuffer:async()=>bytes.buffer.slice(0),text:async()=>new TextDecoder().decode(bytes)};
 }
 async head(key){const object=await this.get(key);return object?{size:object.size,httpMetadata:object.httpMetadata}:null;}
}
