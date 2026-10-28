import { identity, ReadingError, requireValue, readBody } from './validation.mjs';
import { hmacHex, equalHex, issueToken, verifyToken } from '../core/auth.mjs';
import { runModel, endpoint } from '../core/model-adapter.mjs';
import { effectiveAIEnv } from './ai-settings.mjs';
import {meteredModelFetch} from './service-meter.mjs';

export async function readVerifiedGatewayJson(request,env) {
  requireValue(env.AI_SHARED_SECRET,'gateway_not_configured',503);
  const raw=new TextDecoder().decode(await readBody(request,128*1024));
  const timestamp=request.headers.get('X-Webhook-Timestamp')||'',signature=request.headers.get('X-Webhook-Signature-V2')||'';
  requireValue(/^\d{10}$/.test(timestamp)&&Math.abs(Math.floor(Date.now()/1000)-Number(timestamp))<=300,'signature_expired',401);
  requireValue(equalHex(signature,await hmacHex(env.AI_SHARED_SECRET,`${timestamp}.${raw}`)),'invalid_signature',401);
  let body; try {body=JSON.parse(raw);}catch {throw new ReadingError(400,'invalid_json');}
  requireValue(body&&typeof body==='object'&&!Array.isArray(body),'invalid_json');return body;
}
export async function sourcePrincipal(request,env) {
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  const claims=await verifyToken(env.AI_SHARED_SECRET,token,'source');
  requireValue(claims && typeof claims.thread_id==='string','unauthorized',401);return claims;
}
function sourceInput(payload,start,limit) {
  const url=new URL(payload.source_link);
  const parts=url.pathname.split('/').filter(Boolean);
  return {thread_id:payload.thread_id,document_id:identity(parts[1]),version:Number(url.searchParams.get('version')),text_sha256:url.searchParams.get('sha'),start,limit};
}
function replyFor(payload,owner,text,status='completed') {
  return {protocol:'reading-reply-v1',owner_id:owner,thread_id:payload.thread_id,turn_id:payload.turn_id,delivery_id:payload.delivery_id,
    actions:status==='completed'?[{kind:'text',text,index:0,count:1}]:[],terminal:{status,retryable:false}};
}
export async function dispatchReadingTurn(env,stub,turnId,owner,origin,fetchImpl=fetch,depth=0) {
  const prepared=await stub.call(owner,'prepareDispatch',{turn_id:turnId});
  if(!prepared.ok)return {status:'unavailable',reason:prepared.error,turn_id:turnId};
  const {payload,turn}=prepared.value;
  let mode=env.AI_MODE || 'mock';
  const claim=await stub.call(owner,'claimDispatch',{turn_id:turnId});
  if(!claim.ok || !claim.value.acquired)return {status:claim.value?.turn.status||'unavailable',duplicate:true,turn_id:turnId,delivery_id:turn.delivery_id};
  try {
    env=await effectiveAIEnv(env,owner,stub);
    mode=env.AI_MODE || 'mock';
    if(mode==='webhook'&&(!env.AI_WEBHOOK_URL||!env.AI_SHARED_SECRET)) {
      await stub.call(owner,'markDispatch',{turn_id:turnId,status:'unavailable',detail_code:'gateway_not_configured'});
      return {status:'unavailable',reason:'gateway_not_configured',turn_id:turnId};
    }
    if(mode==='webhook') {
      const base=new URL(env.PUBLIC_BASE_URL||origin);requireValue(base.protocol==='https:','invalid_callback_origin');
      const token=await issueToken(env.AI_SHARED_SECRET,{purpose:'source',user_id:owner,thread_id:payload.thread_id},3600);
      const envelope={...payload,owner_id:owner,session_id:`reading:${owner}:${payload.thread_id}`,callback_url:new URL('/api/reading/gateway/reply',base).href,source_access:{url:new URL('/api/reading/gateway/source',base).href,token}};
      const raw=JSON.stringify(envelope),timestamp=String(Math.floor(Date.now()/1000));
      const response=await fetchImpl(endpoint(env.AI_WEBHOOK_URL),{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Webhook-Timestamp':timestamp,'X-Webhook-Signature-V2':await hmacHex(env.AI_SHARED_SECRET,`${timestamp}.${raw}`),'X-Request-ID':turn.delivery_id},body:raw});
      const body=await response.json();
      if(response.status!==202||body.status!=='accepted'||body.delivery_id!==turn.delivery_id)throw new Error('Agent did not accept turn');
      await stub.call(owner,'markDispatch',{turn_id:turnId,status:'accepted'});return {status:'accepted',turn_id:turnId,delivery_id:turn.delivery_id};
    }
    let text;
    if(mode==='mock') text=`**演示回复（Mock）**\n\n我们正在讨论《${payload.book.title}》中的“${payload.discussion.topic}”。\n\n${payload.source ? '> '+payload.source.exact+'\n\n' : ''}你刚才说：${payload.user_message.text}\n\n这是用于验证接线的模拟回复。配置自己的 AI 后，就可以继续真实共读。`;
    else if(mode==='model') {
      const modelFetch=meteredModelFetch(env,owner,fetchImpl);
      const history=await stub.call(owner,'modelHistory',{turn_id:turnId});
      const thread=await stub.call(owner,'get',{kind:'thread',id:payload.thread_id});
      const uploadAllowed=(env.MODEL_ALLOW_UPLOAD===true||env.MODEL_ALLOW_UPLOAD==='true')&&thread.ok&&!thread.value.scheduled;
      const catalogAllowed=(env.MODEL_ALLOW_CATALOG===true||env.MODEL_ALLOW_CATALOG==='true')&&thread.ok&&!thread.value.scheduled;
      const catalogCall=operation=>async args=>{const result=await stub.call(owner,operation,{...args,turn_id:turnId});if(!result.ok)throw new ReadingError(result.status,result.error);return result.value;};
      text=await runModel({env,payload,history:history.ok?history.value:[],fetchImpl:modelFetch,...(catalogAllowed?{searchBooks:catalogCall('modelSearchCatalog'),importBook:catalogCall('modelImportCatalog')}:{}),...(uploadAllowed?{addBook:async args=>{const result=await stub.call(owner,'modelAddBook',{...args,turn_id:turnId});if(!result.ok)throw new Error('Book upload rejected');return result.value;}}:{}),readSource:async(start,limit)=>{
        const result=await stub.call(owner,'gatewaySource',sourceInput(payload,start,limit));
        if(!result.ok)throw new Error('Source unavailable');return result.value;
      }});
    } else throw new Error('Unknown AI mode');
    const result=await stub.call(owner,'applyReply',{reply:replyFor(payload,owner,text)});
    if(!result.ok)throw new Error('Reply commit failed');
    const next=await stub.call(owner,'nextPending',{thread_id:payload.thread_id});
    if(next.ok&&next.value&&depth<32)await dispatchReadingTurn(env,stub,next.value.turn_id,owner,origin,fetchImpl,depth+1);
    return {status:'completed',turn_id:turnId,delivery_id:turn.delivery_id};
  } catch(error) {
    if(error?.code==='public_quota_unavailable'){
      await stub.call(owner,'markDispatch',{turn_id:turnId,status:'unavailable',detail_code:'public_quota_unavailable'});
      return {status:'unavailable',reason:'public_quota_unavailable',turn_id:turnId};
    }
    // External Agent must reconcile uncertain requests using the same delivery identity.
    // Model calls are never automatically repeated after an unknown result.
    if(mode==='webhook') {
      await stub.call(owner,'markDispatch',{turn_id:turnId,status:'unavailable',detail_code:'gateway_not_accepted'});
      return {status:'unavailable',reason:'gateway_not_accepted',turn_id:turnId};
    }
    await stub.call(owner,'applyReply',{reply:replyFor(payload,owner,'','failed')});
    const next=await stub.call(owner,'nextPending',{thread_id:payload.thread_id});
    if(next.ok&&next.value&&depth<32)await dispatchReadingTurn(env,stub,next.value.turn_id,owner,origin,fetchImpl,depth+1);
    return {status:'failed',reason:'ai_request_failed',turn_id:turnId};
  }
}
