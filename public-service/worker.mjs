import reading from '../src/cloudflare/entry.mjs';
import {issueToken} from '../src/core/auth.mjs';
import {json,bad,checkOrigin,digest,harden,limitedBody} from './security.js';
export {Registry} from './registry.js';
export {HostedReadingLibraryDO} from './library.mjs';
const serviceRoutes=new Map([
 ['/service/api/register','POST'],['/service/api/login','POST'],['/service/api/logout','POST'],['/service/api/me','GET'],['/service/api/quota-request','POST'],['/service/api/owner-login','POST'],['/service/api/owner/list','GET'],['/service/api/owner/policy','POST'],['/service/api/owner/review','POST'],['/service/api/owner/revoke-owner-sessions','POST'],['/service/api/owner/remove-application','POST']
]);
export default {async fetch(request,env,ctx){
 try{
  const url=new URL(request.url),path=url.pathname;
  if(path==='/health')return harden(json({service:'reading-island-public',version:'1.0.0'}));
  if(!env.INTERNAL_KEY||!env.OWNER_KEY||!env.SESSION_SECRET)bad('公共服务正在准备中',503);
  checkOrigin(request);
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  if(env.EDGE_RATE&&!(await env.EDGE_RATE.limit({key:ip})).success)bad('请求过于频繁，请稍后重试',429);
  const registry=env.REGISTRY.getByName('reading-public:v1');
  const headers=new Headers({'X-Service-Key':env.INTERNAL_KEY,'X-Ip-Hash':await digest(env.INTERNAL_KEY+ip),'Cookie':request.headers.get('Cookie')||''});
  const registryCall=(path,method='GET',body)=>registry.fetch(new Request('https://registry'+path,{method,headers,body}));
  if(serviceRoutes.has(path)){
   if(request.method!==serviceRoutes.get(path))bad('method not allowed',405);
   if(!path.includes('/owner/')&&!['/service/api/owner-login','/service/api/me','/service/api/logout'].includes(path)){const admit=await registryCall('/internal/admit');if(!admit.ok)return harden(admit);}
   const body=request.method==='GET'?undefined:await limitedBody(request,12000);
   return harden(await registryCall(path==='/service/api/owner-login'?'/internal/owner-login':path,request.method,body));
  }
  if(path==='/download/app.apk'){
   if(!['GET','HEAD'].includes(request.method))bad('method not allowed',405);
   if(env.DOWNLOAD_RATE&&!(await env.DOWNLOAD_RATE.limit({key:ip})).success)bad('下载过于频繁',429);
   const apk=await env.ASSETS.fetch(new Request(new URL('/download/reading-island.apk',url)));
   if(!apk.ok)bad('APK 正在准备中，请先使用网页版',404);
   return new Response(request.method==='HEAD'?null:apk.body,{headers:{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="reading-island.apk"','Cache-Control':'public, max-age=600','X-Content-Type-Options':'nosniff'}});
  }
  if(path==='/'||path==='/app'||path==='/owner')return harden(await env.ASSETS.fetch(new Request(new URL('/service/index.html',url))));
  if(path.startsWith('/api/')||path==='/reading-island/'||path==='/reading-island/index.html'){
   if(path.startsWith('/api/reading/gateway/')||(path==='/api/session'&&request.method==='POST'))bad('not found',404);
   if(path==='/api/session'&&request.method==='DELETE')return harden(await registryCall('/service/api/logout','POST',new Uint8Array()));
   const admit=await registryCall('/internal/admit');if(!admit.ok)return harden(admit);
   const access=await registryCall('/internal/access');
   if(!access.ok){if(!path.startsWith('/api/'))return Response.redirect(new URL('/app',url),302);return harden(json({error:'public_account_required',loginUrl:'/app',message:'请到公共服务账户页登录并等待审批。'},access.status));}
   const {user}=await access.json();
   if(path==='/api/session'&&request.method==='GET'){
    const stub=env.READING_LIBRARY.getByName('reading-island:v1:owner:'+user.id);
    const current=await stub.call(user.id,'getProfile');
    if(current.ok&&!current.value.revision)await stub.call(user.id,'putProfile',{revision:0,username:user.name});
   }
   if(path==='/api/public-usage'){
    const result=await env.READING_LIBRARY.getByName('reading-island:v1:owner:'+user.id).call(user.id,'hostedUsage');
    return harden(json(result,result.ok?200:result.status));
   }
   const trusted=new Headers(request.headers);trusted.delete('Cookie');trusted.delete('X-Service-Key');
   trusted.set('Authorization','Bearer '+await issueToken(env.SESSION_SECRET,{purpose:'session',user_id:user.id},60));
   const internal=new Request(request,{headers:trusted});
   const ownerLibrary=env.READING_LIBRARY.getByName('reading-island:v1:owner:'+user.id);
   const bucket={get:async key=>{const file=await ownerLibrary.readObject(user.id,key);return file?{body:file.bytes,size:file.size}:null;}};
   const response=await reading.fetch(internal,{...env,BOOK_BUCKET:bucket,READER_TOKEN:undefined,AI_SHARED_SECRET:undefined,AI_WEBHOOK_URL:undefined,MODEL_API_KEY:undefined},ctx);
   return harden(response);
  }
  if(path.startsWith('/reading-island/')||path.startsWith('/service/'))return harden(await env.ASSETS.fetch(request));
  bad('not found',404);
 }catch(e){return harden(json({ok:false,error:e.status?e.message:'服务暂时不可用'},e.status||503));}
}};
