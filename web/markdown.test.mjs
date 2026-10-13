import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from './markdown.mjs';
test('renders GFM and nested formatting',()=>{const html=renderMarkdown('# 标题\n\n**重点** *斜体* ~~删除~~\n\n> 引用\n\n- 项目\n\n|列|值|\n|---|---|\n|甲|乙|\n\n```js\nconst a=1;\n```');for(const tag of ['h1','strong','em','del','blockquote','ul','table','pre'])assert.ok(html.includes('<'+tag));});
test('raw HTML and unsafe links cannot execute',()=>{const html=renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n![x](https://example.com/x.png)');assert.ok(!html.includes('<script'));assert.ok(!html.includes('href='));assert.ok(!html.includes('<img'));});
test('safe links retain formatting',()=>assert.match(renderMarkdown('[**来源**](https://example.com)'),/rel="noopener noreferrer"><strong>来源/));
