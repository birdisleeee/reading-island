import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {hmacHex,equalHex} from '../../src/core/auth.mjs';
import {replyWithYourAgent} from './reply.mjs';

export async function startAgentBridge({secret,readingOrigin,directory,port=4190,reply=replyWithYourAgent,fetchImpl=fetch}) {
  if(!secret)throw new Error('AI_SHARED_SECRET required');
  const origin=new URL(readingOrigin);
  if(origin.protocol!=='https:')throw new Error('READING_ORIGIN must use HTTPS');
  const store=resolve(directory);await mkdir(store,{recursive:true,mode:0o700});
  const inflight=new Map(),locks=new Map();
  const save=async(id,job)=>{const file=join(store,id+'.json'),temp=file+'.tmp';await writeFile(temp,JSON.stringify(job),{mode:0o600});await rename(temp,file);};
  async function run(id) {
    if(inflight.has(id))return;inflight.set(id,true);
    try {
      const job=JSON.parse(await readFile(join(store,id+'.json'),'utf8'));
      if(!job.reply) {
        if(job.started)return; // An unknown Agent result must be reconciled by its host, not regenerated.
        job.started=true;await save(id,job);
        try {
          const text=await reply(job.payload,{readSource:async(start,limit)=>{
            if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<1||limit>4000||!job.payload.source_link)throw new Error('Invalid source request');
            const ref=new URL(job.payload.source_link),parts=ref.pathname.split('/').filter(Boolean);
            const response=await fetchImpl(new URL('/api/reading/gateway/source',origin),{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${job.payload.source_access.token}`,'Content-Type':'application/json'},body:JSON.stringify({thread_id:job.payload.thread_id,document_id:parts[1],version:Number(ref.searchParams.get('version')),sha:ref.searchParams.get('sha'),start,limit})});
            if(!response.ok)throw new Error('Source read failed');return response.json();
          }});
          if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('Invalid reply');
          job.reply={protocol:'reading-reply-v1',owner_id:job.payload.owner_id,thread_id:job.payload.thread_id,turn_id:job.payload.turn_id,delivery_id:id,actions:[{kind:'text',text,index:0,count:1}],terminal:{status:'completed',retryable:false}};
        }catch {job.reply={protocol:'reading-reply-v1',owner_id:job.payload.owner_id,thread_id:job.payload.thread_id,turn_id:job.payload.turn_id,delivery_id:id,actions:[],terminal:{status:'failed',retryable:false}};}
        await save(id,job);
      }
      for(let attempt=0;attempt<3;attempt++) {
        const raw=JSON.stringify(job.reply),timestamp=String(Math.floor(Date.now()/1000));
        try {
          const response=await fetchImpl(new URL('/api/reading/gateway/reply',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Webhook-Timestamp':timestamp,'X-Webhook-Signature-V2':await hmacHex(secret,`${timestamp}.${raw}`)},body:raw});
          if(response.ok){job.delivered=true;await save(id,job);break;}
        }catch { /* Persist the reply; never regenerate it just to retry delivery. */ }
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
      }
    }finally {inflight.delete(id);}
  }
  const server=createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    try {
      if(req.method!=='POST'||req.url!=='/reading/turn')return send(404,{error:'not_found'});
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>128*1024)return send(413,{error:'too_large'});chunks.push(chunk);}
      const raw=Buffer.concat(chunks).toString('utf8'),timestamp=String(req.headers['x-webhook-timestamp']||'');
      if(!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!equalHex(String(req.headers['x-webhook-signature-v2']||''),await hmacHex(secret,`${timestamp}.${raw}`)))return send(401,{error:'invalid_signature'});
      const payload=JSON.parse(raw),id=payload.delivery_id;
      if(payload.protocol!=='reading-turn-v1'||!/^[A-Za-z0-9_-]{1,100}$/.test(id||'')||payload.callback_url!==new URL('/api/reading/gateway/reply',origin).href||payload.source_access?.url!==new URL('/api/reading/gateway/source',origin).href)return send(400,{error:'invalid_turn'});
      const fingerprint=createHash('sha256').update(JSON.stringify({...payload,source_access:{url:payload.source_access.url}})).digest('hex');
      // Serialise acceptance for this delivery. Reply execution is guarded separately.
      const previous=locks.get(id)||Promise.resolve();let release;const lock=new Promise(resolve=>release=resolve);locks.set(id,lock);await previous;
      try {
        let old;try{old=JSON.parse(await readFile(join(store,id+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(old&&old.fingerprint!==fingerprint)return send(409,{error:'idempotency_conflict'});
        if(!old)await save(id,{fingerprint,payload,delivered:false});
        send(202,{status:'accepted',delivery_id:id});void run(id).catch(()=>{});
      }finally{release();if(locks.get(id)===lock)locks.delete(id);}
    }catch {send(400,{error:'invalid_request'});}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  // A cached reply may be redelivered; an uncertain accepted Agent call is not rerun automatically.
  for(const file of await readdir(store))if(file.endsWith('.json')){
    const job=JSON.parse(await readFile(join(store,file),'utf8'));
    if(job.reply&&!job.delivered)void run(file.slice(0,-5)).catch(()=>{});
  }
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const server=await startAgentBridge({secret:process.env.AI_SHARED_SECRET,readingOrigin:process.env.READING_ORIGIN,directory:process.env.AGENT_DATA_DIR||'.agent-data',port:Number(process.env.PORT||4190)});
  console.log(`Agent reference bridge listening on 127.0.0.1:${server.address().port}; expose through your HTTPS proxy.`);
}
