import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {startupView,prepareInitialArtwork} from '../web/startup-view.mjs';
test('startup uses an unverified neutral personal center and only displays confirmed identity',()=>{
  const {document}=parseHTML(startupView());assert.equal(document.querySelector('h1').textContent,'个人中心');assert.equal(document.querySelector('.startup-id'),null);assert.match(document.querySelector('[role=status]').textContent,/确认登录/);
  const signed=parseHTML(startupView({username:'<读者>',login_id:'reader_1',user_id:'internal'},'打开书架',true)).document;
  assert.equal(signed.querySelector('h1').textContent,'<读者>');assert.equal(signed.querySelector('.startup-id').textContent,'ID · reader_1');assert.equal(signed.querySelector('button').textContent,'重新加载');assert(!signed.querySelector('读者'));
});
test('first artwork decode deduplicates URLs and optional failures cannot block startup',async()=>{
  const seen=[];class ImageClass{set src(value){seen.push(value);}async decode(){if(seen.length===2)throw Error('fixture decode error');}}
  await prepareInitialArtwork(['one','one','','two'],{ImageClass});assert.deepEqual(seen,['one','two']);
  class NeverImage{decode(){return new Promise(()=>{});}}
  await prepareInitialArtwork(['pending'],{ImageClass:NeverImage,timeout:10});
  await prepareInitialArtwork([new Promise(()=>{})],{ImageClass,timeout:10});
  seen.length=0;await prepareInitialArtwork([Promise.resolve(['custom','custom'])],{ImageClass});assert.deepEqual(seen,['custom']);
});
