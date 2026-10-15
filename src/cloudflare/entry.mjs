import { handleReadingApi, handleReadingGatewayApi } from './api.mjs';
import { principalFor, sameSecret, issueToken } from '../core/auth.mjs';
import { readJson, ReadingError } from './validation.mjs';
import {handleAISettings,publicAISettings} from './ai-settings.mjs';
import {handleSchedule} from './schedule-api.mjs';
export { ReadingLibraryDO } from './library-do.mjs';
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname;
    try {
      if(path==='/api/config'){
        const principal=await principalFor(request,env),settings=principal&&env.READING_LIBRARY?await publicAISettings(env,principal.user_id):null;
        return json({aiName:settings?.configured?settings.name:env.AI_NAME||'阅读伙伴',aiMode:settings?.configured?'model':env.AI_MODE||'mock',aiConfigured:Boolean(settings?.configured||env.AI_MODE==='webhook'||(env.MODEL_API_URL&&env.MODEL_API_KEY)),apiOrigin:url.origin,returnUrl:'/',accent:env.THEME_ACCENT||'#86613f',accentText:env.THEME_ACCENT_TEXT||'#ffffff'});
      }
      if(path==='/api/ai-settings'||path==='/api/ai-settings/test')return handleAISettings(request,env,await principalFor(request,env));
      if(path==='/api/topic-schedule')return handleSchedule(request,env,await principalFor(request,env));
      if(path==='/api/session') {
        if(request.method==='GET'){
          const principal=await principalFor(request,env);
          if(!principal)return json({error:'unauthorized'},401);
          const profile=await env.READING_LIBRARY.getByName(`reading-island:v1:owner:${principal.user_id}`).call(principal.user_id,'getProfile');
          return profile.ok?json({...principal,...profile.value}):json({error:profile.error},profile.status);
        }
        const origin=request.headers.get('origin');
        if((origin&&origin!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'cross_origin_forbidden'},403);
        if(request.method==='DELETE')return json({ok:true},200,{'Set-Cookie':'reading_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        if(!env.READER_TOKEN||!env.SESSION_SECRET)return json({error:'auth_not_configured'},503);
        const body=await readJson(request);
        if(!await sameSecret(body.password,env.READER_TOKEN))return json({error:'unauthorized'},401);
        const token=await issueToken(env.SESSION_SECRET,{purpose:'session',user_id:env.DEFAULT_USER_ID||'reader'},86400);
        return json({ok:true},200,{'Set-Cookie':`reading_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${url.protocol==='https:'?'; Secure':''}`});
      }
      if(path.startsWith('/api/reading/gateway/'))return handleReadingGatewayApi(request,env);
      if(path.startsWith('/api/reading/'))return handleReadingApi(request,env,await principalFor(request,env));
      if(path.startsWith('/api/'))return json({error:'not_found'},404);
      if(path==='/')return Response.redirect(new URL('/reading-island/',url),302);
      return env.ASSETS.fetch(request);
    }catch(error){return json({error:error instanceof ReadingError?error.code:'reading_unavailable'},error instanceof ReadingError?error.status:503);}
  }
};
