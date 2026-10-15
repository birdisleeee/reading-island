import {json,bad,random,digest,passwordHash,same,readJSON,cookies,sessionCookie} from './security.js';
import {emptyQuota,validateQuota,QUOTA_FIELDS} from './quota.mjs';
const publicUser=u=>({id:u.id,username:u.username,name:u.name,slug:u.slug,status:u.status,quota:u.quota,revision:u.revision,createdAt:u.createdAt,reviewNote:u.reviewNote||'',request:u.request||null});
export const defaultPolicy=()=>({revision:0,registrationOpen:false,maxActiveAccounts:0,maxAccounts:0,maxPending:0,globalRequestsPerDay:0,quotaBudget:emptyQuota()});
export class Registry {
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.queue=Promise.resolve();}
 fetch(r){const p=this.queue.then(()=>this.run(r)).catch(e=>json({ok:false,error:e.status?e.message:'服务暂时不可用'},e.status||500,e.retryAfter?{'Retry-After':String(e.retryAfter)}:{}));this.queue=p.catch(()=>{});return p;}
 async alarm(){const now=Date.now();for(const prefix of ['session:','rate:']){const rows=await this.storage.list({prefix});for(const [k,v] of rows)if((v.expires||0)<now)await this.storage.delete(k);}await this.storage.setAlarm(now+3600000);}
 async limit(key,max,window){const now=Date.now(),old=await this.storage.get('rate:'+key),bucket=old&&old.expires>now?old:{count:0,expires:now+window};if(bucket.count>=max)throw Object.assign(Error('请求过于频繁，请稍后重试'),{status:429,retryAfter:Math.max(1,Math.ceil((bucket.expires-now)/1000))});bucket.count++;await this.storage.put('rate:'+key,bucket);if(!await this.storage.getAlarm())await this.storage.setAlarm(now+3600000);}
 async session(r){const token=cookies(r).ri_public_session;if(!/^[a-f0-9]{64}$/.test(token||''))return null;const s=await this.storage.get('session:'+await digest(token));return s&&s.expires>Date.now()?s:null;}
 async loginSession(identity){const token=random();await this.storage.put('session:'+await digest(token),{...identity,expires:Date.now()+7*86400000});await this.storage.setAlarm(Date.now()+3600000);return token;}
 async run(r){
  if(!same(r.headers.get('X-Service-Key'),this.env.INTERNAL_KEY))bad('unauthorized',401);
  const url=new URL(r.url),path=url.pathname,storage=this.storage,policy=await storage.get('policy')||defaultPolicy(),ip=r.headers.get('X-Ip-Hash')||'unknown';
  if(path==='/internal/admit'){
   if(!policy.globalRequestsPerDay)bad('公共服务正在准备中，请稍后再试',503);const day=new Date().toISOString().slice(0,10);const u=await storage.get('global:requests');const n=u?.day===day?u.count:0;if(n>=policy.globalRequestsPerDay)bad('公共服务今日请求额度已用完，请稍后再试',429);await this.limit('ip:'+ip,180,60000);await storage.put('global:requests',{day,count:n+1});return json({ok:true});
  }
  if(path==='/internal/entitlement'){
   const u=await storage.get('user:'+url.searchParams.get('id'));if(!u||u.status!=='active')bad('账户尚未获准使用',403);
   return json({ok:true,user:publicUser(u)});
  }
  if(path==='/internal/access'||path==='/internal/ai-attempt'){
   const session=await this.session(r),id=path.endsWith('ai-attempt')?url.searchParams.get('id'):session?.userId;
   const u=id&&await storage.get('user:'+id);if(!u)bad('请先登录',401);if(u.status!=='active')bad('账户尚未获准使用',403);
   const day=new Date().toISOString().slice(0,10),used=await storage.get('usage:'+id)||{day,requests:0,aiCalls:0};
   if(used.day!==day){used.day=day;used.requests=0;}
   if(path.endsWith('ai-attempt')){if(used.aiCalls>=u.quota.aiCalls)bad('AI 请求额度不足，请申请扩容',429);used.aiCalls++;}
   else {if(used.requests>=u.quota.requestsPerDay)bad('今日请求额度已用完',429);used.requests++;}
   await storage.put('usage:'+id,used);return json({ok:true,user:publicUser(u),usage:used});
  }
  const s=await this.session(r);
  if(path==='/internal/owner-login'){await this.limit('owner:global',30,60000);await this.limit('owner:'+ip,5,60000);const d=await readJSON(r);if(!same(d.key,this.env.OWNER_KEY))bad('运营密钥无效',401);const token=await this.loginSession({owner:true});return json({ok:true},200,{'Set-Cookie':sessionCookie(token)});}
  if(path==='/service/api/register'){
   await this.limit('auth:global',60,60000);await this.limit('register:'+ip,3,3600000);if(!policy.registrationOpen)bad('暂未开放注册申请',403);const users=await storage.list({prefix:'user:'});if(users.size>=policy.maxAccounts||[...users.values()].filter(u=>u.status==='pending').length>=policy.maxPending)bad('申请名额暂满，请联系运营者',429);
   const d=await readJSON(r);if(typeof d.username!=='string'||!/^[a-z][a-z0-9_-]{3,23}$/.test(d.username)||typeof d.password!=='string'||d.password.length<12||d.password.length>128||typeof d.name!=='string'||!d.name.trim()||d.name.length>40||typeof d.contact!=='string'||!d.contact.trim()||d.contact.length>120||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>500)bad('请完整填写账号、12位以上密码、称呼、联系方式和用途');
   if(await storage.get('username:'+d.username))bad('账号名已使用');const id=crypto.randomUUID(),salt=random(),u={id,username:d.username,name:d.name.trim(),contact:d.contact.trim(),reason:d.reason.trim(),slug:d.username,status:'pending',quota:emptyQuota(),revision:0,createdAt:new Date().toISOString(),salt,passwordHash:await passwordHash(d.password,salt)};
   await storage.transaction(async tx=>{await tx.put('user:'+id,u);await tx.put('username:'+u.username,id);await tx.put('slug:'+u.slug,id);});const token=await this.loginSession({userId:id});return json({ok:true,user:publicUser(u)},201,{'Set-Cookie':sessionCookie(token)});
  }
  if(path==='/service/api/login'){
   await this.limit('auth:global',60,60000);await this.limit('login:'+ip,5,60000);const d=await readJSON(r);if(typeof d.username!=='string'||!/^[a-z][a-z0-9_-]{3,23}$/.test(d.username)||typeof d.password!=='string'||d.password.length>128)bad('账号或密码无效',401);await this.limit('login-account:'+await digest(d.username),10,60000);const id=await storage.get('username:'+d.username),u=id&&await storage.get('user:'+id);const salt=u?.salt||'dummy-password-salt';const h=await passwordHash(d.password,salt);if(!u||!same(h,u.passwordHash))bad('账号或密码无效',401);const token=await this.loginSession({userId:id});return json({ok:true,user:publicUser(u)},200,{'Set-Cookie':sessionCookie(token)});
  }
  if(path==='/service/api/logout'){const token=cookies(r).ri_public_session;if(s&&/^[a-f0-9]{64}$/.test(token||''))await storage.delete('session:'+await digest(token));return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});}
  if(path==='/service/api/me'){if(!s)bad('请先登录',401);if(s.owner)return json({ok:true,owner:true});const u=await storage.get('user:'+s.userId);if(!u)bad('请先登录',401);return json({ok:true,user:publicUser(u),usage:await storage.get('usage:'+u.id)||{requests:0,aiCalls:0}});}
  if(path==='/service/api/quota-request'){
   if(!s?.userId)bad('请先登录',401);await this.limit('apply:'+s.userId,3,86400000);const d=await readJSON(r),u=await storage.get('user:'+s.userId);if(u.request?.status==='pending')bad('已有待审核申请，请等待运营者处理',409);if(typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>500)bad('请填写申请原因');const desired=validateQuota(d.quota);u.request={id:crypto.randomUUID(),quota:desired,reason:d.reason.trim(),status:'pending',createdAt:new Date().toISOString()};u.revision++;await storage.put('user:'+u.id,u);return json({ok:true,user:publicUser(u)});
  }
  if(!path.startsWith('/service/api/owner/'))bad('not found',404);if(!s?.owner)bad('仅运营者可操作',403);
  if(path.endsWith('/list')){
   const list=await storage.list({prefix:'user:'});return json({ok:true,policy,users:[...list.values()].map(u=>({...publicUser(u),contact:u.contact,reason:u.reason})),globalUsage:await storage.get('global:requests')||{count:0}});
  }
  const d=await readJSON(r);
  if(path.endsWith('/revoke-owner-sessions')){const sessions=await storage.list({prefix:'session:'});await storage.transaction(async tx=>{for(const [k,v] of sessions)if(v.owner)await tx.delete(k);await tx.put('audit:'+crypto.randomUUID(),{action:'revoke-owner-sessions',at:new Date().toISOString()});});return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});}
  if(path.endsWith('/remove-application')){
   const u=await storage.get('user:'+d.id);if(!u)bad('申请不存在',404);if(d.expectedRevision!==u.revision)bad('申请已变化，请刷新',409);if(!['pending','rejected'].includes(u.status)||QUOTA_FIELDS.some(k=>u.quota[k]>0))bad('只能移除未分配额度、没有书库数据的申请');
   const sessions=await storage.list({prefix:'session:'});await storage.transaction(async tx=>{await tx.delete('user:'+u.id);await tx.delete('username:'+u.username);await tx.delete('slug:'+u.slug);for(const [k,v] of sessions)if(v.userId===u.id)await tx.delete(k);await tx.put('audit:'+crypto.randomUUID(),{action:'remove-empty-application',id:u.id,at:new Date().toISOString()});});return json({ok:true});
  }
  if(path.endsWith('/policy')){
   if(d.expectedRevision!==policy.revision)bad('设置已更新，请刷新',409);for(const k of ['maxActiveAccounts','maxAccounts','maxPending','globalRequestsPerDay'])if(!Number.isSafeInteger(d[k])||d[k]<0||d[k]>1000000)bad('请填写有效的服务上限');if(typeof d.registrationOpen!=='boolean')bad('开关无效');const q=validateQuota(d.quotaBudget);const list=await storage.list({prefix:'user:'});if(d.maxAccounts<list.size)bad('账号上限不得小于已注册数量');if(d.maxActiveAccounts<[...list.values()].filter(u=>u.status==='active').length)bad('获批账号上限不能小于当前已批准数量');for(const k of QUOTA_FIELDS){if([...list.values()].reduce((n,u)=>n+u.quota[k],0)>q[k])bad('服务额度不得低于已分配总量');}await storage.put('policy',{revision:policy.revision+1,registrationOpen:d.registrationOpen,maxActiveAccounts:d.maxActiveAccounts,maxAccounts:d.maxAccounts,maxPending:d.maxPending,globalRequestsPerDay:d.globalRequestsPerDay,quotaBudget:q});return json({ok:true});
  }
  if(!path.endsWith('/review'))bad('not found',404);const u=await storage.get('user:'+d.id);if(!u)bad('账户不存在',404);if(d.expectedRevision!==u.revision)bad('申请已变化，请刷新',409);if(!['active','rejected','suspended'].includes(d.status)||typeof d.note!=='string'||d.note.length>500)bad('审核内容无效');const q=validateQuota(d.quota);if(d.status==='active'&&(!q.books||!q.threads||!q.bytes||!q.requestsPerDay))bad('批准时请明确分配书籍、议题、存储和每日请求额度');const users=await storage.list({prefix:'user:'});if(d.status==='active'&&[...users.values()].filter(x=>x.id!==u.id&&x.status==='active').length>=policy.maxActiveAccounts)bad('获批账号数已达上限，请先向运营者申请');for(const k of QUOTA_FIELDS){const sum=[...users.values()].filter(x=>x.id!==u.id).reduce((n,x)=>n+x.quota[k],0)+q[k];if(sum>policy.quotaBudget[k])bad('超过公共服务总额度，请先由运营者调整服务上限');}
  const next={...u,status:d.status,quota:q,revision:u.revision+1,reviewNote:d.note,reviewedAt:new Date().toISOString()};if(next.request)next.request={...next.request,status:d.status==='active'?'approved':'rejected',reviewNote:d.note};
  await storage.transaction(async tx=>{await tx.put('user:'+u.id,next);await tx.put('audit:'+crypto.randomUUID(),{action:'account-review',id:u.id,at:next.reviewedAt,before:{status:u.status,quota:u.quota},after:{status:next.status,quota:q},note:d.note});});return json({ok:true,user:publicUser(next)});
 }
}
