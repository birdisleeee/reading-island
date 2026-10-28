import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readerProfileView} from '../web/reader-profile-view.mjs';
const view=(profile,options)=>parseHTML('<html><body>'+readerProfileView(profile,options)+'</body></html>').document;

test('personal center separates identity, real statistics, editable name and hosted quota access',()=>{
 const document=view({username:'共读读者',login_id:'reader_id',user_id:'internal-id',revision:7},{counts:{books:12,notes:34,threads:5},hosted:true});
 assert.equal(document.querySelector('[data-avatar-preview]').textContent,'共');
 assert.equal(document.querySelector('.profile-display-name').textContent,'共读读者');
 assert.equal(document.querySelector('.profile-login-id span').textContent,'reader_id');
 assert.equal(document.querySelector('[name=username]').value,'共读读者');
 assert.equal(document.querySelector('[name=revision]').value,'7');
 assert.deepEqual([...document.querySelectorAll('.profile-stats dd')].map(e=>e.textContent),['12','34','5']);
 assert.equal(document.querySelectorAll('.profile-card').length,2);
 assert(document.querySelector('[data-action=public-account]'));
 assert.equal(document.querySelectorAll('input:not([type=hidden]):not([type=file])').length,1,'registered ID is never editable');
 assert.equal(document.querySelector('[name=avatar_data]').value,'');
 assert.equal(document.querySelector('[data-avatar-file]').getAttribute('accept'),'image/png,image/jpeg,image/webp');
 assert.equal(document.querySelector('[data-avatar-menu]').hidden,true);
 assert.equal(document.querySelector('[data-avatar-choose]').getAttribute('aria-label'),'选择头像图片');
 assert.equal(document.querySelector('.profile-avatar-tools'),null);
 assert.equal(document.querySelector('[data-avatar-clear]'),null);
 assert(!document.body.textContent.includes('internal-id'));
});

test('an uploaded avatar keeps adjustment and replacement inside its collapsed menu',()=>{
 const document=view({username:'共读者',avatar_data:'data:image/jpeg;base64,/9j/2Q=='});
 const menu=document.querySelector('[data-avatar-menu]'),choose=document.querySelector('[data-avatar-choose]');
 assert.equal(menu.hidden,true);assert.equal(menu.getAttribute('role'),'menu');
 assert.equal(choose.getAttribute('aria-haspopup'),'menu');assert.equal(choose.getAttribute('aria-expanded'),'false');
 assert.equal(choose.getAttribute('aria-controls'),menu.id);
 assert.equal(document.querySelector('[data-avatar-adjust]').closest('[data-avatar-menu]'),menu);
 assert.equal(document.querySelector('[data-avatar-replace]').closest('[data-avatar-menu]'),menu);
 assert(!document.body.textContent.includes('恢复默认头像'));
});

test('personal center escapes names and IDs without introducing profile fields or invented statistics',()=>{
 const document=view({username:'<img src=x onerror=alert(1)>',login_id:'<script>id</script>',revision:2},{counts:{books:Infinity,notes:-1,threads:'45'},hosted:false});
 assert.equal(document.querySelector('img'),null);assert.equal(document.querySelector('script'),null);
 assert.equal(document.querySelector('[name=username]').value,'<img src=x onerror=alert(1)>');
 assert.equal(document.querySelector('.profile-login-id span').textContent,'<script>id</script>');
 assert.deepEqual([...document.querySelectorAll('.profile-stats dd')].map(e=>e.textContent),['0','0','0']);
 assert.equal(document.querySelector('[data-action=public-account]'),null);
});

test('personal center handles an empty display name and legacy fixed identity',()=>{
 const document=view({username:'',user_id:'legacy-fixed-id',revision:0});
 assert.equal(document.querySelector('[data-avatar-preview]').textContent,'读');
 assert.equal(document.querySelector('.profile-login-id span').textContent,'legacy-fixed-id');
 assert.equal(document.querySelectorAll('.profile-card').length,1);
});
