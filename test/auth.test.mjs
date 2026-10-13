import test from 'node:test';
import assert from 'node:assert/strict';
import { issueToken,verifyToken,principalFor,hmacHex,equalHex } from '../src/core/auth.mjs';
test('session signatures reject tampering, purpose changes and expiry',async()=>{
  const token=await issueToken('test-key',{purpose:'session',user_id:'alice'});
  assert.equal((await verifyToken('test-key',token,'session')).user_id,'alice');
  assert.equal(await verifyToken('other-key',token,'session'),null);
  assert.equal(await verifyToken('test-key',token,'source'),null);
  assert.equal(await verifyToken('test-key',token+'x','session'),null);
  assert.equal(await verifyToken('test-key',await issueToken('test-key',{purpose:'session',user_id:'alice'},-1),'session'),null);
});
test('cookie and host Bearer tokens resolve the signed identity',async()=>{
  const token=await issueToken('test-key',{purpose:'session',user_id:'bob'});
  const env={SESSION_SECRET:'test-key'};
  assert.equal((await principalFor(new Request('https://example.test',{headers:{cookie:`reading_session=${token}`}}),env)).user_id,'bob');
  assert.equal((await principalFor(new Request('https://example.test',{headers:{Authorization:`Bearer ${token}`}}),env)).user_id,'bob');
  assert.equal(await principalFor(new Request('https://example.test',{headers:{'X-User-Id':'bob'}}),env),null);
  assert.equal(equalHex(await hmacHex('a','b'),await hmacHex('b','a')),false);
});
