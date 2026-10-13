import {identity,requireValue,ReadingError,readJson} from './validation.mjs';
import {issueToken,verifyToken} from '../core/auth.mjs';
import {endpoint,runModel} from '../core/model-adapter.mjs';
const encode=new TextEncoder();
export const DEEPSEEK={provider:'deepseek',api_url:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',name:'阅读伙伴',system_prompt:''};
const defaults=()=>({...DEEPSEEK,has_key:false,configured:false,revision:0,tested_at:null});
const namespace=(env,owner)=>env.READING_LIBRARY.getByName(`reading-island:v1:owner:${identity(owner)}`);
async function record(env,owner){const result=await namespace(env,owner).call(owner,'getAISettings');if(!result.ok)throw new ReadingError(result.status,result.error);return result.value;}
async function key(env){requireValue(env.SESSION_SECRET,'auth_not_configured',503);const hash=await crypto.subtle.digest('SHA-256',encode.encode('reading-ai-settings-v1:'+env.SESSION_SECRET));return crypto.subtle.importKey('raw',hash,{name:'AES-GCM'},false,['encrypt','decrypt']);}
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
async function encrypt(env,owner,value){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode.encode(owner)},await key(env),encode.encode(JSON.stringify(value)));return {iv:b64(iv),cipher:b64(cipher)};}
async function decrypt(env,owner,stored){try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(stored.iv),additionalData:encode.encode(owner)},await key(env),bytes(stored.cipher))));}catch{throw new ReadingError(503,'settings_key_unreadable');}}
export async function publicAISettings(env,owner){const saved=await record(env,owner);return saved?{...saved.public,has_key:true,configured:true,revision:saved.revision,tested_at:saved.tested_at}:defaults();}
export async function effectiveAIEnv(env,owner){const saved=await record(env,owner);if(!saved)return env;const value=await decrypt(env,owner,saved);return {...env,AI_MODE:'model',AI_NAME:value.name,MODEL_API_URL:value.api_url,MODEL_API_KEY:value.api_key,MODEL_NAME:value.model,MODEL_PROVIDER:value.provider,MODEL_SYSTEM_PROMPT:value.system_prompt};}
function validateURL(value){const url=new URL(endpoint(value));requireValue(!url.search && !/^(localhost|.*\.(?:localhost|local|internal))$/i.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':'),'invalid_ai_endpoint');return url.href;}
async function normalize(env,owner,input){
  requireValue(['deepseek','compatible'].includes(input.provider),'invalid_provider');
  const api_url=input.provider==='deepseek'?DEEPSEEK.api_url:validateURL(String(input.api_url||''));
  const model=String(input.model||'').trim(),name=String(input.name||'阅读伙伴').trim(),system_prompt=String(input.system_prompt||'');
  requireValue(/^[a-zA-Z0-9_.:/-]{1,100}$/.test(model),'invalid_model');requireValue(name.length>0&&name.length<=60&&system_prompt.length<=4000,'invalid_input');
  let api_key=String(input.api_key||'').trim();
  if(!api_key){const saved=await record(env,owner);requireValue(saved,'api_key_required');api_key=(await decrypt(env,owner,saved)).api_key;}
  requireValue(api_key.length>0&&api_key.length<=4096&&!/[\r\n]/.test(api_key),'invalid_api_key');
  return {provider:input.provider,api_url,model,name,system_prompt,api_key};
}
async function fingerprint(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encode.encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function probeAISettings(env,owner,input,fetchImpl=fetch){
  requireValue(env.SESSION_SECRET,'auth_not_configured',503);
  const value=await normalize(env,owner,input);let sourceRead=false;
  const text=await runModel({env:{MODEL_API_URL:value.api_url,MODEL_API_KEY:value.api_key,MODEL_NAME:value.model,MODEL_PROVIDER:value.provider},payload:{book:{title:'连接测试短文'},discussion:{topic:'测试原文工具'},source_link:'reading://source/probe/doc',user_message:{text:'请先调用 read_source，start=0、limit=100，再用一句话回答读到的内容。'}},probe:true,readSource:async()=>{sourceRead=true;return {text:'这是一段用于验证共读接线的原创短文。',start:0,end:22};},fetchImpl});
  requireValue(sourceRead&&typeof text==='string'&&text.trim(),'source_tool_not_supported',422);
  const proof=await issueToken(env.SESSION_SECRET,{purpose:'ai-tested',user_id:owner,fingerprint:await fingerprint(value)},600);
  return {ok:true,proof,message:'连接成功，已验证文字回复和原文读取工具。测试通过后可保存。'};
}
const messages={api_key_required:'请填写 API Key。',model_auth_failed:'Key 无效或没有此模型的访问权限。',model_credit_failed:'服务返回余额或支付问题，请检查自己的 API 账户。',model_rate_limited:'服务暂时限流，请稍后手动测试。',model_request_failed:'服务拒绝了测试请求，请检查地址、模型和工具支持。',model_unreachable:'连接失败或超时，请检查服务地址。',source_tool_not_supported:'文字服务可连接，但原文工具未通过，请换用支持工具调用的模型。',settings_key_unreadable:'已保存的 Key 无法读取，请重新填写 Key。',invalid_ai_endpoint:'请输入公开的 HTTPS 接口地址，不要在 URL 中填写密钥。',invalid_model:'请检查模型名称。',test_required:'请先测试当前配置，成功后再保存。',revision_conflict:'配置已在另一窗口修改，请重新打开设置。'};
export async function handleAISettings(request,env,principal){
  const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  try{
    requireValue(principal?.role==='reader','unauthorized',401);requireValue(env.READING_LIBRARY,'reading_not_configured',503);
    const owner=identity(principal.user_id),url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/ai-settings')return json(await publicAISettings(env,owner));
    const origin=request.headers.get('origin');requireValue((!origin||origin===url.origin)&&request.headers.get('sec-fetch-site')!=='cross-site','cross_origin_forbidden',403);
    const input=await readJson(request);
    if(request.method==='POST'&&url.pathname==='/api/ai-settings/test')return json(await probeAISettings(env,owner,input));
    requireValue(request.method==='PUT'&&url.pathname==='/api/ai-settings','method_not_allowed',405);
    const value=await normalize(env,owner,input),claims=await verifyToken(env.SESSION_SECRET,input.proof,'ai-tested');
    requireValue(claims?.user_id===owner&&claims.fingerprint===await fingerprint(value),'test_required',409);
    const {api_key,...publicValue}=value;
    const result=await namespace(env,owner).call(owner,'putAISettings',{...await encrypt(env,owner,value),public:publicValue,revision:input.revision,tested_at:new Date().toISOString()});
    requireValue(result.ok,result.error,result.status);return json(await publicAISettings(env,owner));
  }catch(error){const code=error instanceof ReadingError?error.code:error.code||'model_unreachable';return json({error:code,message:messages[code]||'暂时无法完成，请检查配置后重试。'},error instanceof ReadingError?error.status:422);}
}
