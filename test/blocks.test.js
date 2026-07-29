import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  boldParagraph,
  bullet,
  doneBlocks,
  DROPPED_LABEL,
  droppedBlocks,
  headingText,
  heading2,
  learningBlocks,
  richText,
  scaffold,
  SECTIONS,
  TEXT_LIMIT,
} from '../src/blocks.js';

describe('richText', () => {
  test('빈 문자열은 빈 배열', () => {
    assert.deepEqual(richText(''), []);
    assert.deepEqual(richText(null), []);
  });

  test('짧은 텍스트는 rich_text 하나', () => {
    assert.deepEqual(richText('안녕'), [{ type: 'text', text: { content: '안녕' } }]);
  });

  test('2000자를 넘으면 나눈다 — 내용은 그대로 보존', () => {
    const long = 'ㄱ'.repeat(TEXT_LIMIT * 2 + 37);
    const items = richText(long);
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.text.content.length <= TEXT_LIMIT));
    assert.equal(items.map((item) => item.text.content).join(''), long);
  });

  test('annotations 를 붙인다', () => {
    assert.deepEqual(richText('제목', { color: 'purple' })[0].annotations, { color: 'purple' });
  });
});

describe('bullet', () => {
  test('sub 가 없으면 children 키를 만들지 않는다', () => {
    const block = bullet('항목');
    assert.equal(block.type, 'bulleted_list_item');
    assert.equal('children' in block.bulleted_list_item, false);
  });

  test('sub 는 중첩 불릿이 된다', () => {
    const block = bullet('항목', ['발견: 복잡함', '배움: 나누자']);
    const children = block.bulleted_list_item.children;
    assert.equal(children.length, 2);
    assert.equal(children[0].bulleted_list_item.rich_text[0].text.content, '발견: 복잡함');
  });

  test('빈 sub 항목은 버린다', () => {
    const block = bullet('항목', ['', '   ', '실제']);
    assert.equal(block.bulleted_list_item.children.length, 1);
  });
});

describe('doneBlocks', () => {
  test('group 이 있으면 굵은 소제목을 앞에 넣는다', () => {
    const blocks = doneBlocks([{ group: '장바구니 개선', bullets: [{ text: '담기 버튼 버그 수정', sub: [] }] }]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks[0].paragraph.rich_text[0].annotations.bold, true);
    assert.equal(blocks[0].paragraph.rich_text[0].text.content, '장바구니 개선');
    assert.equal(blocks[1].type, 'bulleted_list_item');
  });

  test('group 이 null 이면 소제목 없이 불릿만', () => {
    const blocks = doneBlocks([{ group: null, bullets: [{ text: '항목', sub: [] }] }]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'bulleted_list_item');
  });

  test('bullets 가 비면 그룹 자체를 건너뛴다', () => {
    assert.deepEqual(doneBlocks([{ group: '빈그룹', bullets: [] }]), []);
    assert.deepEqual(doneBlocks([{ group: '빈그룹', bullets: [{ text: '  ', sub: [] }] }]), []);
  });

  test('인자가 없어도 터지지 않는다', () => {
    assert.deepEqual(doneBlocks(), []);
  });
});

describe('learningBlocks', () => {
  test('빈 텍스트는 걸러낸다', () => {
    const blocks = learningBlocks([{ text: '배움', sub: [] }, { text: '', sub: [] }]);
    assert.equal(blocks.length, 1);
  });
});

describe('droppedBlocks — 분류 실패해도 원문은 남는다', () => {
  test('비어 있으면 아무것도 만들지 않는다', () => {
    assert.deepEqual(droppedBlocks([]), []);
    assert.deepEqual(droppedBlocks(['  ']), []);
  });

  test('라벨과 원문 불릿을 만든다', () => {
    const blocks = droppedBlocks(['알 수 없는 조각', '또 하나']);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].paragraph.rich_text[0].text.content, DROPPED_LABEL);
    assert.equal(blocks[2].bulleted_list_item.rich_text[0].text.content, '또 하나');
  });
});

describe('scaffold', () => {
  test('두 섹션의 헤딩·가이드·구분선을 만든다', () => {
    const blocks = scaffold();
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['heading_2', 'quote', 'divider', 'heading_2', 'quote'],
    );
    assert.equal(headingText(blocks[0]), SECTIONS.done.title);
    assert.equal(headingText(blocks[3]), SECTIONS.learnings.title);
    assert.equal(blocks[0].heading_2.rich_text[0].annotations.color, 'purple');
    assert.equal(blocks[3].heading_2.rich_text[0].annotations.color, 'green');
    assert.equal(blocks[1].quote.color, 'gray');
  });
});

describe('headingText', () => {
  test('노션 응답의 plain_text 를 읽는다', () => {
    const block = { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '오늘 한 일' }] } };
    assert.equal(headingText(block), '오늘 한 일');
  });

  test('직접 만든 블록의 text.content 도 읽는다', () => {
    assert.equal(headingText(heading2('한 줄 배움 / 감정', 'green')), '한 줄 배움 / 감정');
  });

  test('여러 조각으로 쪼개진 제목을 합친다', () => {
    const block = { type: 'heading_2', heading_2: { rich_text: [{ plain_text: '오늘 ' }, { plain_text: '한 일' }] } };
    assert.equal(headingText(block), '오늘 한 일');
  });

  test('heading_2 가 아니면 null', () => {
    assert.equal(headingText({ type: 'divider', divider: {} }), null);
    assert.equal(headingText(boldParagraph('x')), null);
    assert.equal(headingText(null), null);
  });
});
