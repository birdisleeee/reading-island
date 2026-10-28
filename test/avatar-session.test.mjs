import test from 'node:test';
import assert from 'node:assert/strict';

test('late profile responses cannot restore an older avatar or undo a newer clear',async()=>{
 const original=globalThis.document,events=[];globalThis.document={dispatchEvent:event=>events.push(event.detail)};
 try{
  const {updateSession,getSession}=await import('../web/session.mjs?avatar-session-test');
  updateSession({user_id:'alice',username:'A',revision:1,hosted:true,login_id:'reader',avatar_data:'first'});
  updateSession({user_id:'alice',username:'B',revision:2,avatar_data:'second'});
  const stale=updateSession({user_id:'alice',username:'A',revision:1,avatar_data:'first'});
  assert.equal(stale.avatar_data,'second');assert.equal(stale.revision,2);assert.equal(events.length,2);
  updateSession({user_id:'alice',username:'B',revision:3});
  assert.equal(getSession().avatar_data,'');assert.equal(getSession().hosted,true);
  updateSession({user_id:'alice',username:'B',revision:2,avatar_data:'second'});assert.equal(getSession().avatar_data,'');
  updateSession({user_id:'bob',username:'Other',revision:0});
  assert.equal(getSession().user_id,'bob');assert.equal(getSession().avatar_data,'');assert.equal(getSession().login_id,undefined);assert.equal(getSession().hosted,undefined);
 }finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
