import test from 'node:test';
import assert from 'node:assert/strict';
import { runModel,endpoint } from '../src/core/model-adapter.mjs';
const env={MODEL_API_URL:'https://model.example.test/chat',MODEL_API_KEY:'fixture-key',MODEL_NAME:'fixture'};
const payload={book:{title:'示例'},discussion:{topic:'讨论'},user_message:{text:'怎么看？'},source_link:'reading://source/thread_a/doc_a'};
test('model receives the reader ID and username as discussion data',async()=>{
  const reader={user_id:'alice',username:'海边读者'};
  await runModel({env,payload:{...payload,reader},fetchImpl:async(url,init)=>{
    const messages=JSON.parse(init.body).messages;
    const context=JSON.parse(messages.find(item=>item.content.startsWith('当前共读资料')).content.split('\n').slice(1).join('\n'));
    assert.deepEqual(context.reader,reader);
    return Response.json({choices:[{message:{content:'你好，海边读者。'}}]});
  }});
});
test('model tools read only the host-scoped source and preserve tool call identity',async()=>{
  const bodies=[];let sourceCalls=0;
  const result=await runModel({env,payload,history:[{author:'me',text:'上一句话'}],readSource:async(start,limit)=>{sourceCalls++;assert.equal(start,3);assert.equal(limit,20);return {text:'示例原文'};},fetchImpl:async(url,init)=>{
    assert.equal(url,env.MODEL_API_URL);bodies.push(JSON.parse(init.body));
    return Response.json(bodies.length===1?{choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_a',type:'function',function:{name:'read_source',arguments:'{"start":3,"limit":20}'}}]}}]}:{choices:[{message:{content:'**读过后的回复**'}}]});
  }});
  assert.equal(result,'**读过后的回复**');assert.equal(sourceCalls,1);
  assert.equal(bodies[1].messages.at(-1).tool_call_id,'call_a');
  assert.equal(bodies[1].messages.at(-2).role,'assistant');
  assert.equal(bodies[0].messages[2].content,'上一句话');
});
test('model tool budget rejects unsupported tools and oversized source ranges',async()=>{
  for(const fn of [{name:'fetch_any_url',arguments:'{}'},{name:'read_source',arguments:'{"start":0,"limit":5000}'}]) {
    await assert.rejects(runModel({env,payload,readSource:()=>{throw new Error('must not read');},fetchImpl:async()=>Response.json({choices:[{message:{tool_calls:[{id:'call',type:'function',function:fn}]}}]})}));
  }
  assert.throws(()=>endpoint('http://model.example.test/chat'));
  assert.throws(()=>endpoint('https://secret@model.example.test/chat'));
});
