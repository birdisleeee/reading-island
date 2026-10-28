import test from 'node:test';
import assert from 'node:assert/strict';
import {ARTWORK_COMPARE_LIMIT,sameArtworkBlob} from '../web/artwork-blob.mjs';

test('independently loaded copies of the same rendered image compare equal',async()=>{
  const original=new Blob([new Uint8Array([137,80,78,71,0,1,255])],{type:'image/png'}),reloaded=structuredClone(original);
  assert.notEqual(original,reloaded);assert.equal(await sameArtworkBlob(original,reloaded),true);
  assert.equal(await sameArtworkBlob(new Blob(['image'],{type:'image/png'}),new Blob(['image'],{type:'image/png'})),true);
});

test('changed pixels, MIME or length require replacement even with matching coarse metadata',async()=>{
  const original=new Blob(['first'],{type:'image/png'});
  assert.equal(await sameArtworkBlob(original,new Blob(['other'],{type:'image/png'})),false);
  assert.equal(await sameArtworkBlob(original,new Blob(['first'],{type:'image/jpeg'})),false);
  assert.equal(await sameArtworkBlob(original,new Blob(['first-more'],{type:'image/png'})),false);
});

test('missing artwork is stable while replacement and reset are distinct',async()=>{
  const image=new Blob(['picture'],{type:'image/png'});
  assert.equal(await sameArtworkBlob(null,undefined),true);assert.equal(await sameArtworkBlob(undefined,null),true);
  assert.equal(await sameArtworkBlob(null,image),false);assert.equal(await sameArtworkBlob(image,null),false);
  assert.equal(await sameArtworkBlob({blob:'invalid'},null),true);
});

test('same-object artwork avoids reads and legacy oversized records are not read into memory',async()=>{
  class UnreadableBlob extends Blob{async arrayBuffer(){throw new Error('must not read');}}
  const same=new UnreadableBlob(['same'],{type:'image/png'});assert.equal(await sameArtworkBlob(same,same),true);
  const large=new UnreadableBlob([new Uint8Array(ARTWORK_COMPARE_LIMIT+1)],{type:'image/png'});
  assert.equal(await sameArtworkBlob(large,large.slice(0,large.size,large.type)),false);
});

test('a failed local image read rejects so callers retain the previous artwork',async()=>{
  class FailedBlob extends Blob{async arrayBuffer(){throw new Error('fixture local read failed');}}
  await assert.rejects(sameArtworkBlob(new Blob(['same'],{type:'image/png'}),new FailedBlob(['same'],{type:'image/png'})),/fixture local read failed/);
});
