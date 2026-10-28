import {ReadingLibraryDO} from '../src/cloudflare/library-do.mjs';
import {ReadingError} from '../src/cloudflare/validation.mjs';
import {serviceAccess} from '../src/cloudflare/service-meter.mjs';
import {SqlObjectStore} from './object-store.mjs';
const size=value=>new TextEncoder().encode(value).byteLength;
// SQL and object reservations share the same owner DO, so concurrent uploads cannot overspend.
export class HostedReadingLibraryDO extends ReadingLibraryDO {
 constructor(ctx,env){
  super(ctx,env);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hosted_objects (key TEXT PRIMARY KEY, size INTEGER NOT NULL)');
  const bucket=new SqlObjectStore(ctx.storage);
  this.meteredBucket={get:(...a)=>bucket.get(...a),head:(...a)=>bucket.head(...a),put:async(key,body,options)=>{
   const bytes=typeof body==='string'?size(body):body.byteLength;
   if(!Number.isSafeInteger(bytes))throw new ReadingError(413,'invalid_file_size');
   ctx.storage.transactionSync(()=>{
    const old=ctx.storage.sql.exec('SELECT size FROM hosted_objects WHERE key=?',key).toArray()[0];
    if(old){if(old.size!==bytes+256)throw new ReadingError(409,'immutable_size_conflict');return;}
    this.checkStorage(bytes+256);
    ctx.storage.sql.exec('INSERT INTO hosted_objects(key,size) VALUES(?,?)',key,bytes+256);
   });
   // A failed write keeps its reservation. Retrying the same key reuses it; it never creates free untracked data.
   return bucket.put(key,body,options);
  }};
 }
 documentBucket(){return this.meteredBucket;}
 readerLoginId(owner){return this.grant?.username||owner;}
 async readObject(owner,key){
  await this.refreshGrant(owner);
  const stored=this.ctx.storage.sql.exec('SELECT id FROM reading_owner LIMIT 1').toArray()[0];
  if(stored?.id!==owner||!key.startsWith('reading-island/v1/owners/'+owner+'/books/'))throw new ReadingError(403,'owner_mismatch');
  const object=await this.meteredBucket.get(key);
  return object?{size:object.size,bytes:new Uint8Array(await object.arrayBuffer())}:null;
 }
 usage(){
  const rows=this.ctx.storage.sql.exec("SELECT kind, COUNT(*) AS count, SUM(length(CAST(value AS BLOB))+256) AS bytes FROM reading_records GROUP BY kind").toArray();
  const objectBytes=this.ctx.storage.sql.exec('SELECT COALESCE(SUM(size),0) AS bytes FROM hosted_objects').toArray()[0].bytes;
  return {books:rows.find(r=>r.kind==='book')?.count||0,threads:rows.find(r=>r.kind==='thread')?.count||0,bytes:rows.reduce((n,r)=>n+r.bytes,0)+objectBytes};
 }
 checkStorage(delta){if(!this.grant||this.usage().bytes+delta>this.grant.quota.bytes)throw new ReadingError(429,'storage_quota_exceeded');}
 beforeRecordWrite(kind,id,value){
  const old=this.ctx.storage.sql.exec('SELECT value FROM reading_records WHERE kind=? AND id=?',kind,id).toArray()[0];
  // Releasing a task's reserved status space must still work after an operator lowers the quota.
  if(kind==='catalog_job'&&old&&size(JSON.stringify(value))<=size(old.value))return;
  const used=this.usage();
  if(!old&&['book','thread'].includes(kind)&&used[kind==='book'?'books':'threads']>=this.grant.quota[kind==='book'?'books':'threads'])throw new ReadingError(429,'record_quota_exceeded');
  this.checkStorage(size(JSON.stringify(value))-(old?size(old.value):0)+(old?0:256));
 }
 async refreshGrant(owner){
  const {user}=await serviceAccess(this.env,'entitlement',owner);
  if(!this.grant||user.revision>=this.grant.revision)this.grant=user;
 }
 async call(owner,operation,input={}){
  try{
   await this.refreshGrant(owner);
   if(operation==='hostedUsage')return {ok:true,value:this.usage()};
   return super.call(owner,operation,input);
  }catch(e){return {ok:false,status:e.status||503,error:e.code||'public_account_unavailable'};}
 }
 async alarm(){
  const owner=this.ctx.storage.sql.exec('SELECT id FROM reading_owner LIMIT 1').toArray()[0]?.id;
  if(!owner)return;
  try{await this.refreshGrant(owner);}catch{await this.ctx.storage.deleteAlarm();return;}
  return super.alarm();
 }
}
