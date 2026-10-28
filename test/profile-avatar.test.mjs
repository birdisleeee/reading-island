import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Response as WorkerResponse} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';
import {validateAvatarData,AVATAR_DATA_LIMIT} from '../src/cloudflare/avatar-validation.mjs';

// A generated 256x256 solid-colour JPEG, containing no user image or metadata.
const JPEG='/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAEAAQADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCvAQqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q==';
const avatar='data:image/jpeg;base64,'+JPEG;
const bindings={SESSION_SECRET:'avatar-fixture-secret',READER_TOKEN:'fixture-password',AI_MODE:'webhook',AI_WEBHOOK_URL:'https://agent.test/turn',AI_SHARED_SECRET:'avatar-agent-fixture',PUBLIC_BASE_URL:'https://reading.test'};
const script=build({entryPoints:[resolve('src/cloudflare/entry.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']}).then(result=>result.outputFiles[0].text);
async function request(mf,path,method='GET',body,owner='alice',headers={}){
  return mf.dispatchFetch('https://reading.test'+path,{method,headers:{Authorization:'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
const read=async(mf,owner='alice')=>(await(await request(mf,'/api/reading/profile','GET',undefined,owner)).json());
function fixtureOptions(compiled,persist,external){return {modules:true,script:compiled,compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},durableObjectsPersist:persist,r2Buckets:['BOOK_BUCKET'],r2Persist:join(persist,'r2'),bindings,outboundService:external};}

test('avatar validation accepts only canonical bounded 256px JPEG data',()=>{
  assert.equal(validateAvatarData(avatar),avatar);assert.equal(validateAvatarData(''),'');
  for(const value of [null,{},'https://image.test/avatar.jpg','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,AA==','data:image/jpeg;base64,','data:image/jpeg;base64,AA=','data:image/jpeg;base64,AAAA\n','data:image/jpeg;base64,!!!!','data:image/jpeg;base64,/9j/2R=='])assert.throws(()=>validateAvatarData(value),error=>error.status===400);
  assert.throws(()=>validateAvatarData('data:image/jpeg;base64,'+'A'.repeat(AVATAR_DATA_LIMIT)),error=>error.status===413);
  const wrongSize=Buffer.from(JPEG,'base64'),sof=wrongSize.indexOf(Buffer.from([0xff,0xc0]));assert(sof>=0);wrongSize.writeUInt16BE(4096,sof+7);
  const noEnd=Buffer.from(JPEG,'base64');noEnd[noEnd.length-1]=0;
  for(const bytes of [wrongSize,noEnd,Buffer.from([0xff,0xd8,0xff,0xd9])])assert.throws(()=>validateAvatarData('data:image/jpeg;base64,'+bytes.toString('base64')),error=>error.status===415);
});

test('avatar and reading name persist atomically across restart, preserve omission, clear explicitly and isolate owners',async()=>{
  const persist=await mkdtemp(join(tmpdir(),'reading-profile-avatar-')),compiled=await script;
  let mf=new Miniflare(fixtureOptions(compiled,persist,async()=>new WorkerResponse('unused',{status:503})));
  try{
    assert.equal((await mf.dispatchFetch('https://reading.test/api/reading/profile')).status,401);
    const first=await request(mf,'/api/reading/profile','PATCH',{username:'头像读者',revision:0,avatar_data:avatar,user_id:'bob'});assert.equal(first.status,200);assert.deepEqual(await first.json(),{user_id:'alice',username:'头像读者',avatar_data:avatar,revision:1});
    assert.equal((await(await request(mf,'/api/session')).json()).avatar_data,avatar);
    assert.deepEqual(await read(mf,'bob'),{user_id:'bob',username:'bob',revision:0});
    await mf.dispose();mf=new Miniflare(fixtureOptions(compiled,persist,async()=>new WorkerResponse('unused',{status:503})));
    assert.deepEqual(await read(mf),{user_id:'alice',username:'头像读者',avatar_data:avatar,revision:1});
    const rename=await request(mf,'/api/reading/profile','PATCH',{username:'新的称呼',revision:1});assert.equal(rename.status,200);assert.equal((await rename.json()).avatar_data,avatar);
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'旧草稿',revision:1,avatar_data:''})).status,409);
    assert.equal((await read(mf)).avatar_data,avatar,'conflicting clear cannot discard the current avatar');
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'未保存',revision:2,avatar_data:'data:image/jpeg;base64,AAAA'})).status,415);
    assert.deepEqual(await read(mf),{user_id:'alice',username:'新的称呼',avatar_data:avatar,revision:2},'invalid avatar changes neither name nor revision');
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'跨源',revision:2,avatar_data:''},'alice',{Origin:'https://other.test'})).status,403);
    const cleared=await request(mf,'/api/reading/profile','PATCH',{username:'新的称呼',revision:2,avatar_data:''});assert.equal(cleared.status,200);assert.deepEqual(await cleared.json(),{user_id:'alice',username:'新的称呼',revision:3});
    assert.equal(Object.hasOwn(await(await request(mf,'/api/session')).json(),'avatar_data'),false);
    assert.deepEqual(await read(mf,'bob'),{user_id:'bob',username:'bob',revision:0});
  }finally{await mf.dispose();assert(resolve(persist).startsWith(resolve(tmpdir())+requireSeparator()),'temporary cleanup must stay under the task temp root');await rm(persist,{recursive:true,force:true});}
});

test('Agent delivery and reader context exclude avatar bytes',async()=>{
  const persist=await mkdtemp(join(tmpdir(),'reading-avatar-context-')),calls=[],mf=new Miniflare(fixtureOptions(await script,persist,async req=>{const value=await req.json();calls.push(value);return WorkerResponse.json({status:'accepted',delivery_id:value.delivery_id},{status:202});}));
  try{
    assert.equal((await request(mf,'/api/reading/profile','PATCH',{username:'共读者',revision:0,avatar_data:avatar})).status,200);
    assert.equal((await request(mf,'/api/reading/books','POST',{book_id:'original_book',title:'原创验证'})).status,200);
    assert.equal((await request(mf,'/api/reading/threads','POST',{thread_id:'original_thread',book_id:'original_book',title:'共读',opening:'你好',opening_message_id:'original_message',turn_id:'original_turn',delivery_id:'original_delivery'})).status,200);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].reader,{user_id:'alice',username:'共读者'});assert(!JSON.stringify(calls[0]).includes(JPEG));
    const context=await(await request(mf,'/api/reading/threads/original_thread/context')).json();assert.deepEqual(context.reader,{user_id:'alice',username:'共读者'});assert(!JSON.stringify(context).includes(JPEG));
  }finally{await mf.dispose();assert(resolve(persist).startsWith(resolve(tmpdir())+requireSeparator()),'temporary cleanup must stay under the task temp root');await rm(persist,{recursive:true,force:true});}
});

function requireSeparator(){return process.platform==='win32'?'\\':'/';}
