import test from 'node:test';
import assert from 'node:assert/strict';
import {formatReview} from '../src/ai-markdown.mjs';

test('formats review headings, emphasis, numbered lists and tables, without enabling HTML or remote content',()=>{
  const html=formatReview('```markdown\n## 结论\n\n**稳定**\n\n1. 第一区间\n2. 第二区间\n\n| 项目 | 功率 |\n| --- | --- |\n| 首段 | 150 W |\n\n[链接](javascript:alert%281%29) ![封面](https://example.test/p.png) <img src=x onerror=alert(1)>\n```');
  for(const term of ['<h4>结论</h4>','<strong>稳定</strong>','<ol>','<table>','150 W','链接','封面'])assert.ok(html.includes(term),term);
  assert.doesNotMatch(html,/<(?:a|img)\b|javascript:|onerror=|```/);
});
