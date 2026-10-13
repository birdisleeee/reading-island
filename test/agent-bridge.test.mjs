import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {startAgentBridge} from '../examples/agent-bridge/server.mjs';
import {hmacHex} from '../src/core/auth.mjs';
test('HTTP Agent example validates signatures, persists replies and deduplicates accepted delivery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reading-agent-'));let calls=0;const callbacks=[];
 const server=await startAgentBridge({secret:'fixture-secret',readingOrigin:'https://reading.example.test',directory:dir,port:0,reply:async()=>{calls++;return '已有 Agent 回复';},fetchImpl:async(url,init)=>{callbacks.push(JSON.parse(init.body));return Response.json({ok:true});}});
 const url=`http://127.0.0.1:${server.address().port}/reading/turn`;
 try {
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  const payload={protocol:'reading-turn-v1',owner_id:'alice',thread_id:'thread_a',turn_id:'turn_a',delivery_id:'delivery_a',book:{title:'示例'},discussion:{topic:'讨论'},user_message:{text:'第一句'},callback_url:'https://reading.example.test/api/reading/gateway/reply',source_access:{url:'https://reading.example.test/api/reading/gateway/source',token:'fixture-capability'}};
  const post=async(value)=>{const raw=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000));return fetch(url,{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature-V2':await hmacHex('fixture-secret',`${timestamp}.${raw}`)},body:raw});};
  assert.equal((await post(payload)).status,202);assert.equal((await post(payload)).status,202);
  for(let i=0;i<100&&!callbacks.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,1);assert.equal(callbacks[0].actions[0].text,'已有 Agent 回复');
  assert.equal((await post({...payload,user_message:{text:'changed'}})).status,409);
 }finally{await new Promise(resolve=>server.close(resolve));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&basename(dir).startsWith('reading-agent-'));await rm(dir,{recursive:true,force:true});}
});
