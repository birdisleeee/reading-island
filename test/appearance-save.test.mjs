import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

async function harness(name,run) {
  const previous={document:globalThis.document,indexedDB:globalThis.indexedDB};
  const opens=[],writes=[];
  globalThis.document=parseHTML('<html><head></head><body></body></html>').document;
  globalThis.indexedDB={open(){const request={};opens.push(request);return request;}};
  const release=()=>{
    const request=opens.shift();assert.ok(request,'an IndexedDB open is waiting');
    request.result={close(){},transaction(){const tx={objectStore:()=>({put:value=>writes.push(value),delete:id=>writes.push({id,deleted:true})})};queueMicrotask(()=>tx.oncomplete());return tx;}};
    request.onsuccess();
  };
  try {await run(await import('../web/appearance.mjs?test='+name),{opens,writes,release});}
  finally {globalThis.document=previous.document;globalThis.indexedDB=previous.indexedDB;}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('an old appearance write cannot overwrite a later live preview',()=>harness('preview',async(m,db)=>{
  m.previewAppearance('theme',{...m.THEME_DEFAULTS,text:'#112233'});
  const save=m.saveAppearance('theme',m.appearanceValues('theme'));await flush();
  m.previewAppearance('theme',{...m.THEME_DEFAULTS,text:'#abcdef'});
  db.release();await save;
  assert.equal(db.writes[0].values.text,'#112233');
  assert.equal(m.appearanceValues('theme').text,'#abcdef');
  assert.equal(document.documentElement.style.getPropertyValue('--ink'),'#abcdef');
}));

test('cancelling a drawer while its save is pending keeps the restored preview',()=>harness('cancel',async(m,db)=>{
  const snapshot=m.appearanceSnapshot();
  m.previewAppearance('theme',{...m.THEME_DEFAULTS,text:'#112233'});
  const save=m.saveAppearance('theme',m.appearanceValues('theme'));await flush();
  m.restoreAppearance(snapshot);db.release();await save;
  assert.equal(m.appearanceValues('theme').text,snapshot.theme.text);
}));

test('successive saves persist in submission order and keep the latest preview',()=>harness('order',async(m,db)=>{
  m.previewAppearance('theme',{...m.THEME_DEFAULTS,text:'#112233'});
  const first=m.saveAppearance('theme',m.appearanceValues('theme'));
  m.previewAppearance('theme',{...m.THEME_DEFAULTS,text:'#abcdef'});
  const second=m.saveAppearance('theme',m.appearanceValues('theme'));await flush();
  assert.equal(db.opens.length,1);db.release();await first;await flush();
  assert.equal(db.opens.length,1);db.release();await second;
  assert.deepEqual(db.writes.map(value=>value.values.text),['#112233','#abcdef']);
  assert.equal(m.appearanceValues('theme').text,'#abcdef');
}));
