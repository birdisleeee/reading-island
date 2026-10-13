import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupDiscussionMessages} from './discussion-messages.mjs';

test('one bubble per contiguous assistant turn preserves all text, quotes and other turns',()=>{
  const messages=[
    {author:'assistant',turn_id:'a',text:'**第一段**'},
    {author:'assistant',turn_id:'a',text:'第二段',quote:{text:'原文'}},
    {author:'me',turn_id:'b',text:'我的问题'},
    {author:'assistant',turn_id:'b',text:'另一轮'},
    {author:'assistant',turn_id:'c',text:'独立回复'},
    {author:'assistant',text:'没有绑定的旧消息'},
    {author:'assistant',text:'另一条旧消息'},
  ];
  const frozen=structuredClone(messages);
  const groups=groupDiscussionMessages(messages);
  assert.deepEqual(groups.map(g=>g.parts.length),[2,1,1,1,1,1]);
  assert.deepEqual(groups.flatMap(g=>g.parts),frozen);
  assert.deepEqual(messages,frozen);
});
