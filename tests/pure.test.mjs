/**
 * 纯函数单测。
 *
 * 只测「不碰 DOM 就能判定对错」的部分：
 *   - 切句 / 分段（决定了朗读节奏和进度条映射）
 *   - 块偏移契约（决定了「点哪读哪」准不准）
 *   - 版本比较、等待时间估算
 *
 * 出声、高亮、面板这些要真人耳朵/眼睛的，走 docs/REGRESSION.md。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadReader } from './harness.mjs';

// vm 里造出来的数组/对象和本进程不是同一个 realm，
// deepStrictEqual 会因为原型不同而报「same structure but not reference-equal」。
// JSON 往返一次，规整成当前 realm 的普通值再比。
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('脚本加载', () => {
  it('不建面板也能加载，并挂出测试钩子', () => {
    const { api, window } = loadReader();
    assert.match(window.__dshProbe, /^v\d+\.\d+\.\d+$/);
    for (const name of ['splitSentences', 'buildChunksFrom', 'textFromBlocks', 'compareVersions', 'estimateFor', 'uniqueTurnIds', 'pickNewTurns', 'shouldAutoRead']) {
      assert.equal(typeof api[name], 'function', `缺少 ${name}`);
    }
  });
});

describe('splitSentences：切朗读单位', () => {
  it('空输入返回空数组', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.splitSentences('')), []);
    assert.deepEqual(plain(api.splitSentences('   \n  ')), []);
    assert.deepEqual(plain(api.splitSentences(null)), []);
  });

  it('按句末标点切开，标点留在句尾', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.splitSentences('你好。世界！')), ['你好。', '世界！']);
    assert.deepEqual(plain(api.splitSentences('一？二；三…')), ['一？', '二；', '三…']);
  });

  it('没有句末标点、又不超过 220 字的，保持一句', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.splitSentences('这是一句没有标点的话')), ['这是一句没有标点的话']);
  });

  it('超长无标点片段在 200 字处硬切', () => {
    const { api } = loadReader();
    const out = plain(api.splitSentences('a'.repeat(300)));
    assert.equal(out.length, 2);
    assert.equal(out[0].length, 201);
    assert.equal(out[1].length, 99);
    assert.equal(out.join('').length, 300);
  });

  it('超长片段优先在逗号处切', () => {
    const { api } = loadReader();
    const text = 'x'.repeat(150) + '，' + 'y'.repeat(100);
    const out = plain(api.splitSentences(text));
    assert.equal(out.length, 2);
    assert.ok(out[0].endsWith('，'), '第一段应在逗号后断开');
    assert.equal(out[0].length, 151);
  });

  it('没有句末标点的超短碎片并入上一句', () => {
    const { api } = loadReader();
    // 「嗯」只有 1 个字、没有标点，会和前一句粘起来（这是刻意的合并规则）
    assert.deepEqual(plain(api.splitSentences('你好。嗯')), ['你好。嗯']);
  });

  it('统一空白：多空格压成一个，CRLF 归一', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.splitSentences('  a   b  ')), ['a b']);
    // 两行都超过 6 字，不会被「短碎片合并」规则粘起来
    assert.deepEqual(plain(api.splitSentences('第一行内容啊\r\n第二行内容啊')), ['第一行内容啊', '第二行内容啊']);
  });
});

describe('buildChunksFrom：分段与进度映射', () => {
  const S = ['a', 'b', 'c', 'd', 'e'];

  it('空句子列表返回空', () => {
    const { api, state } = loadReader();
    state.sentences = [];
    assert.deepEqual(plain(api.buildChunksFrom(0, 100)), []);
  });

  it('段与段首尾相接，覆盖 [start, 末尾]', () => {
    const { api, state } = loadReader();
    state.sentences = S;
    const chunks = plain(api.buildChunksFrom(0, 3));
    assert.equal(chunks[0].from, 0);
    assert.equal(chunks.at(-1).to, S.length);
    for (let i = 1; i < chunks.length; i += 1) {
      assert.equal(chunks[i].from, chunks[i - 1].to, '上一段的 to 必须等于下一段的 from');
    }
    for (const c of chunks) assert.ok(c.from <= c.to);
  });

  it('每段不超过 maxChars（单句本身超长时除外）', () => {
    const { api, state } = loadReader();
    state.sentences = ['12345', '67890', 'abcde', 'fghij'];
    const chunks = plain(api.buildChunksFrom(0, 12));
    for (const c of chunks) assert.ok(c.text.length <= 12, `段长 ${c.text.length} > 12`);
  });

  it('从中间 start 开始时，from 跟着走', () => {
    const { api, state } = loadReader();
    state.sentences = ['a', 'b', 'c'];
    const chunks = plain(api.buildChunksFrom(1, 100));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].from, 1);
    assert.equal(chunks[0].to, 3);
  });

  it('上一句没有句末标点时，用换行分隔', () => {
    const { api, state } = loadReader();
    state.sentences = ['abc', 'def'];
    assert.equal(api.buildChunksFrom(0, 100)[0].text, 'abc\ndef');
  });

  it('上一句有句末标点时，直接拼接', () => {
    const { api, state } = loadReader();
    state.sentences = ['abc。', 'def'];
    assert.equal(api.buildChunksFrom(0, 100)[0].text, 'abc。def');
  });

  it('默认段长是 300 字', () => {
    const { api, state } = loadReader();
    state.sentences = ['x'.repeat(200), 'y'.repeat(200)];
    assert.equal(api.buildChunksFrom(0).length, 2);
  });

  it('已知限制：单句超过 maxChars 时不会被拆开', () => {
    const { api, state } = loadReader();
    state.sentences = ['x'.repeat(400)];
    const chunks = plain(api.buildChunksFrom(0, 100));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text.length, 400);
  });
});

describe('块偏移契约：点哪读哪的地基', () => {
  // collectBlocks 的偏移算法（start += 文本长度 + 1），这里用纯数据复刻，
  // 验证 textFromBlocks 拼出来的全文和 start 严格对齐。
  function simulateBlocks(texts) {
    let start = 0;
    return texts.map((text) => {
      const b = { text, start };
      start += text.length + 1;
      return b;
    });
  }

  it('每块都能在全文里按 start 精确切出来', () => {
    const { api } = loadReader();
    const blocks = simulateBlocks(['第一段', '第二段\n带换行', '第三段']);
    const full = api.textFromBlocks(blocks);
    for (const b of blocks) {
      assert.equal(full.slice(b.start, b.start + b.text.length), b.text);
    }
  });

  it('textFromBlocks 用换行连接', () => {
    const { api } = loadReader();
    assert.equal(api.textFromBlocks([{ text: 'a' }, { text: 'b' }]), 'a\nb');
    assert.equal(api.textFromBlocks([]), '');
  });
});

describe('compareVersions：更新检查', () => {
  it('按段比较数字，不是按字符串', () => {
    const { api } = loadReader();
    assert.ok(api.compareVersions('1.16.0', '1.15.18') > 0);
    assert.ok(api.compareVersions('1.16.1', '1.16.0') > 0);
    assert.ok(api.compareVersions('2.0.0', '1.99.99') > 0);
  });

  it('相等与缺段', () => {
    const { api } = loadReader();
    assert.equal(api.compareVersions('1.16.0', '1.16.0'), 0);
    assert.equal(api.compareVersions('1.16', '1.16.0'), 0);
    assert.equal(api.compareVersions('1.16.0', '1.16'), 0);
  });
});

describe('estimateFor：等待时间估算', () => {
  it('没有样本时按 字数 × 8ms + 1200ms 估', () => {
    const { api } = loadReader();
    assert.equal(api.estimateFor(100), 2000);
    assert.equal(api.estimateFor(10), 1280);
  });

  it('上限 15 秒、下限 1 秒', () => {
    const { api } = loadReader();
    assert.equal(api.estimateFor(100000), 15000);
    assert.ok(api.estimateFor(1) >= 1000);
  });

  it('字数越多，估算不减', () => {
    const { api } = loadReader();
    assert.ok(api.estimateFor(500) > api.estimateFor(100));
  });
});

describe('自动朗读：回合筛选（纯判定）', () => {
  it('uniqueTurnIds 去重、排序、丢掉非法值', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.uniqueTurnIds(['3', '1', '3', 'x', '0', '-2', '2'])), [1, 2, 3]);
    assert.deepEqual(plain(api.uniqueTurnIds([])), []);
  });

  it('pickNewTurns 只返回基线之后、没读过的回合', () => {
    const { api } = loadReader();
    assert.deepEqual(plain(api.pickNewTurns(['1', '2', '3', '4'], [3], 2)), [4]);
    assert.deepEqual(plain(api.pickNewTurns(['1', '2'], [], 5)), []);
    assert.deepEqual(plain(api.pickNewTurns(['1', '2', '3'], [2, 3], 0)), [1]);
  });

  it('shouldAutoRead 只认有实质内容的文本', () => {
    const { api } = loadReader();
    assert.equal(api.shouldAutoRead('好的'), true);
    assert.equal(api.shouldAutoRead('ok'), true);
    assert.equal(api.shouldAutoRead('123'), true);
    assert.equal(api.shouldAutoRead('。。。'), false);
    assert.equal(api.shouldAutoRead('   '), false);
    assert.equal(api.shouldAutoRead(''), false);
    assert.equal(api.shouldAutoRead('a'), false); // 少于两个字
  });
});
