import {ReadingError} from './validation.mjs';
// Only the separately configured public Worker has this binding and secret.
export async function serviceAccess(env,route,owner){
 const stub=env.REGISTRY.getByName('reading-public:v1');
 const response=await stub.fetch(new Request('https://registry/internal/'+route+'?id='+encodeURIComponent(owner),{headers:{'X-Service-Key':env.INTERNAL_KEY}}));
 const value=await response.json();
 if(!response.ok)throw new ReadingError(response.status,'public_quota_unavailable');
 return value;
}
export function meteredModelFetch(env,owner,fetchImpl){
 if(env.PUBLIC_SERVICE!=='true')return fetchImpl;
 return async(...args)=>{await serviceAccess(env,'ai-attempt',owner);return fetchImpl(...args);};
}
