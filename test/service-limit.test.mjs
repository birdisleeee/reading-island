import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../public-service/registry.js';
import {initialPolicy,suggestedQuota,QUOTA_FIELDS} from '../public-service/quota.mjs';

test('legacy exhausted AI counters survive retirement; daily, global and burst limits still gate autonomous attempts',async()=>{
 const day=new Date().toISOString().slice(0,10),data=new Map();
 const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>{data.set(k,structuredClone(v));},getAlarm:async()=>1,setAlarm:async()=>{}};
 data.set('policy',{...initialPolicy,globalRequestsPerDay:3000});
 data.set('user:legacy',{id:'legacy',username:'legacy',name:'原创',status:'active',quota:{...suggestedQuota,aiCalls:600},revision:1});
 data.set('usage:legacy',{day,requests:0,aiCalls:600});
 const registry=new Registry({storage},{INTERNAL_KEY:'fixture-only'});
 const attempt=()=>registry.fetch(new Request('https://registry/internal/ai-attempt?id=legacy',{headers:{'X-Service-Key':'fixture-only'}}));
 let r=await attempt();assert.equal(r.status,200);let result=await r.json();
 assert.equal(result.usage.aiCalls,601);assert.equal(result.usage.requests,1);assert.equal(result.user.quota.aiCalls,undefined);
 assert.equal(data.get('user:legacy').quota.aiCalls,600,'stored grants are not rewritten during upgrade');
 assert.ok(!QUOTA_FIELDS.includes('aiCalls'));
 for(let i=1;i<120;i++)assert.equal((await attempt()).status,200);
 assert.equal((await attempt()).status,429,'short bursts remain bounded without an IP or browser');
 data.delete('rate:ai:legacy');
 data.set('usage:legacy',{day,requests:1000,aiCalls:720});assert.equal((await attempt()).status,429,'account daily limit applies');
 data.set('usage:legacy',{day:'2000-01-01',requests:1000,aiCalls:720});
 assert.equal((await attempt()).status,200,'new UTC day resets service use, not lifetime history');
 assert.equal(data.get('usage:legacy').requests,1);assert.equal(data.get('usage:legacy').aiCalls,721);
 data.set('global:requests',{day,count:3000});assert.equal((await attempt()).status,429,'global daily protection includes background attempts');
 assert.equal(data.get('usage:legacy').requests,1,'blocked attempts do not consume account budget');
 data.set('global:requests',{day,count:0});data.get('user:legacy').status='suspended';assert.equal((await attempt()).status,403);
});
