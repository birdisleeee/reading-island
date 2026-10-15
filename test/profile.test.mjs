import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { issueToken } from '../src/core/auth.mjs';

const bindings = { SESSION_SECRET:'profile-fixture-secret', READER_TOKEN:'fixture-password', AI_MODE:'webhook', AI_WEBHOOK_URL:'https://agent.test/turn', AI_SHARED_SECRET:'profile-agent-secret', PUBLIC_BASE_URL:'https://reading.test' };
async function request(mf, path, method='GET', body, owner='alice', headers={}) {
  return mf.dispatchFetch('https://reading.test'+path,{method,headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
}
test('reader profile is authenticated, owner-scoped, revision checked and frozen into Agent turns', async()=>{
  const calls=[];
  const mf=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings,outboundService:async req=>{
    const value=await req.json();calls.push(value);return WorkerResponse.json({status:'accepted',delivery_id:value.delivery_id},{status:202});
  }});
  try {
    assert.equal((await mf.dispatchFetch('https://reading.test/api/reading/profile')).status,401);
    assert.deepEqual(await (await request(mf,'/api/reading/profile')).json(),{user_id:'alice',username:'alice',revision:0});
    const changed=await request(mf,'/api/reading/profile','PATCH',{username:'海边读者',revision:0,user_id:'bob',owner_id:'bob'});
    assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{user_id:'alice',username:'海边读者',revision:1});
    assert.equal((await (await request(mf,'/api/session')).json()).username,'海边读者');
    assert.deepEqual(await (await request(mf,'/api/reading/profile','GET',null,'bob')).json(),{user_id:'bob',username:'bob',revision:0});
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'旧窗口',revision:0})).status,409);
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'跨站',revision:1},'alice',{Origin:'https://elsewhere.test'})).status,403);
    for(const username of ['', ' ', 'a'.repeat(61), 'name\nnext'])assert.equal((await request(mf,'/api/reading/profile','PATCH',{username,revision:1})).status,400);
    assert.equal((await request(mf,'/api/reading/books','POST',{book_id:'book_a',title:'原创短文'})).status,200);
    assert.equal((await request(mf,'/api/reading/threads','POST',{thread_id:'thread_a',book_id:'book_a',title:'一起读',opening:'你好',opening_message_id:'message_a',turn_id:'turn_a',delivery_id:'delivery_a',reader:{user_id:'bob',username:'伪造身份'}})).status,200);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].reader,{user_id:'alice',username:'海边读者'});assert.equal(calls[0].owner_id,'alice');
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'新名字',revision:1})).status,200);
    const stub=(await mf.getDurableObjectNamespace('READING_LIBRARY')).getByName('reading-island:v1:owner:alice');
    const frozen=await stub.call('alice','prepareDispatch',{turn_id:'turn_a'});
    assert.deepEqual(frozen.value.payload.reader,{user_id:'alice',username:'海边读者'});
    const context=await (await request(mf,'/api/reading/threads/thread_a/context')).json();
    assert.deepEqual(context.reader,{user_id:'alice',username:'新名字'});
  } finally { await mf.dispose(); }
});
