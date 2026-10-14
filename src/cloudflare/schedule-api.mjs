import {identity,readJson,requireValue,ReadingError} from './validation.mjs';
export async function handleSchedule(request,env,principal){
  const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  try{
    requireValue(principal?.role==='reader','unauthorized',401);requireValue(env.READING_LIBRARY,'reading_not_configured',503);
    const url=new URL(request.url),origin=request.headers.get('origin');requireValue((!origin||origin===url.origin)&&request.headers.get('sec-fetch-site')!=='cross-site','cross_origin_forbidden',403);
    requireValue(['GET','PUT'].includes(request.method),'method_not_allowed',405);
    const owner=identity(principal.user_id),stub=env.READING_LIBRARY.getByName(`reading-island:v1:owner:${owner}`);
    const result=await stub.call(owner,request.method==='GET'?'getSchedule':'putSchedule',request.method==='PUT'?{...await readJson(request),origin:url.origin}:{});
    return result.ok?json(result.value):json({error:result.error},result.status);
  }catch(error){return json({error:error instanceof ReadingError?error.code:'schedule_unavailable'},error instanceof ReadingError?error.status:503);}
}
