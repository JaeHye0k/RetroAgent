import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { headingText } from '../src/blocks.js';
import { PERIOD_SECTIONS } from '../src/cycles.js';
import {
  clearTemplateCache,
  loadTemplate,
  parseTemplate,
  sectionBlocks,
  TemplateError,
} from '../src/template.js';

const types = (blocks) => blocks.map((b) => b.type);
const content = (block) => (block[block.type].rich_text ?? []).map((rt) => rt.text.content).join('');

describe('parseTemplate — 마크다운 → 노션 블록', () => {
  test('헤딩과 색', () => {
    const { blocks, sections } = parseTemplate('## 오늘 한 일 {purple}');
    assert.deepEqual(types(blocks), ['heading_2']);
    assert.equal(headingText(blocks[0]), '오늘 한 일');
    assert.equal(blocks[0].heading_2.rich_text[0].annotations.color, 'purple');
    assert.deepEqual(sections, [{ title: '오늘 한 일', color: 'purple' }]);
  });

  test('색을 안 적으면 default', () => {
    const { blocks, sections } = parseTemplate('## Keep');
    assert.equal(blocks[0].heading_2.rich_text[0].annotations.color, 'default');
    assert.deepEqual(sections, [{ title: 'Keep', color: 'default' }]);
  });

  test('제목에 슬래시가 들어가도 그대로 읽는다', () => {
    assert.equal(headingText(parseTemplate('## 한 줄 배움 / 감정 {green}').blocks[0]), '한 줄 배움 / 감정');
  });

  test('인용은 gray 블록', () => {
    const { blocks } = parseTemplate('> 가이드 문구');
    assert.deepEqual(types(blocks), ['quote']);
    assert.equal(blocks[0].quote.color, 'gray');
    assert.equal(content(blocks[0]), '가이드 문구');
  });

  test('연속된 인용 줄은 한 블록으로 합친다', () => {
    const { blocks } = parseTemplate('> 첫 줄\n> 둘째 줄');
    assert.equal(blocks.length, 1);
    assert.equal(content(blocks[0]), '첫 줄\n둘째 줄');
  });

  test('빈 줄로 끊기면 인용이 나뉜다', () => {
    const { blocks } = parseTemplate('> 첫 블록\n\n> 둘째 블록');
    assert.deepEqual(types(blocks), ['quote', 'quote']);
  });

  test('구분선', () => {
    assert.deepEqual(types(parseTemplate('---').blocks), ['divider']);
    assert.deepEqual(types(parseTemplate('-----').blocks), ['divider']);
  });

  test('불릿과 들여쓴 하위 항목', () => {
    const { blocks } = parseTemplate('- 부모\n  - 자식 하나\n  - 자식 둘\n- 다음 부모');
    assert.deepEqual(types(blocks), ['bulleted_list_item', 'bulleted_list_item']);
    const children = blocks[0].bulleted_list_item.children;
    assert.equal(children.length, 2);
    assert.equal(content(children[0]), '자식 하나');
    assert.ok(!blocks[1].bulleted_list_item.children, '두 번째 부모엔 자식이 없다');
  });

  test('체크박스', () => {
    const { blocks } = parseTemplate('- [ ] 안 한 것\n- [x] 한 것');
    assert.deepEqual(types(blocks), ['to_do', 'to_do']);
    assert.equal(blocks[0].to_do.checked, false);
    assert.equal(blocks[1].to_do.checked, true);
    assert.equal(content(blocks[1]), '한 것');
  });

  test('빈 체크박스 — 내용이 없어도 블록은 만든다', () => {
    const { blocks } = parseTemplate('- [ ]');
    assert.deepEqual(types(blocks), ['to_do']);
  });

  /** 조용히 넘기면 의도와 다른 페이지가 노션에 올라간다. 시끄럽게 실패해야 한다. */
  test('모르는 문법은 던진다', () => {
    assert.throws(() => parseTemplate('# 1단계 헤딩은 안 쓴다'), TemplateError);
    assert.throws(() => parseTemplate('그냥 문단'), TemplateError);
  });

  test('에러에 몇 번째 줄인지 적는다', () => {
    assert.throws(() => parseTemplate('## 제목\n\n알 수 없는 줄'), /3번째 줄/);
  });

  test('부모 없는 들여쓴 항목은 던진다', () => {
    assert.throws(() => parseTemplate('  - 외톨이'), /부모 없는/);
  });

  test('헤딩이 나오면 들여쓰기 기준이 끊긴다', () => {
    assert.throws(() => parseTemplate('- 부모\n## 새 섹션\n  - 외톨이'), /부모 없는/);
  });
});

describe('sectionBlocks — 섹션 머리말 꺼내기', () => {
  const template = parseTemplate('## A {red}\n> 가이드 A\n\n---\n\n## B\n> 가이드 B\n- 항목');

  test('헤딩과 그 아래 인용까지만 준다', () => {
    const blocks = sectionBlocks(template, 'B');
    assert.deepEqual(types(blocks), ['heading_2', 'quote']);
    assert.equal(content(blocks[1]), '가이드 B');
  });

  test('없는 섹션은 null', () => {
    assert.equal(sectionBlocks(template, '없음'), null);
  });
});

describe('loadTemplate', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retro-template-'));
    clearTemplateCache();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    clearTemplateCache();
  });

  test('실제 템플릿의 섹션이 주기 정의와 맞는다', async () => {
    const { sections } = await loadTemplate('weekly');
    const titles = sections.map((s) => s.title);
    for (const title of Object.values(PERIOD_SECTIONS)) {
      assert.ok(titles.includes(title), `${title} 이 templates/period.md 에 있어야 한다`);
    }
  });

  test('주기 회고는 전부 같은 템플릿을 쓴다', async () => {
    const weekly = await loadTemplate('weekly');
    const yearly = await loadTemplate('yearly');
    assert.equal(weekly, yearly, '같은 파일이면 한 번만 읽는다');
  });

  /** md 에서 제목을 바꿔 코드와 어긋나면, 노션에 올리기 전에 알아야 한다. */
  test('기대하는 섹션이 없으면 던진다', async () => {
    await fs.writeFile(path.join(dir, 'period.md'), '## 엉뚱한 섹션\n> 가이드\n', 'utf8');
    await assert.rejects(() => loadTemplate('weekly', { dir }), TemplateError);
    await assert.rejects(() => loadTemplate('weekly', { dir }), /Keep/);
  });

  test('파일이 없으면 어느 경로인지 알려준다', async () => {
    await assert.rejects(() => loadTemplate('daily', { dir }), /daily\.md/);
  });

  test('모르는 주기는 던진다', async () => {
    await assert.rejects(() => loadTemplate('decade'), /알 수 없는 주기/);
  });
});
