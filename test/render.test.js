process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  escapeHtml,
  previewKeyboard,
  renderFragments,
  renderPreview,
  splitForTelegram,
  TELEGRAM_LIMIT,
} from '../src/render.js';

const draft = {
  date: '2026-07-26',
  done: [
    {
      group: '장바구니 개선',
      bullets: [
        { text: '담기 버튼 버그 수정', sub: [] },
        { text: '결제 로그 미배포', sub: ['발견: 결제 단계가 4개'] },
      ],
    },
    { group: null, bullets: [{ text: '커피 2잔', sub: [] }] },
  ],
  learnings: [{ text: 'staleTime 과 gcTime 을 헷갈리고 있었다', sub: [] }],
  dropped: ['알 수 없는 조각'],
};

describe('escapeHtml', () => {
  test('HTML 특수문자를 막는다', () => {
    assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  });

  test('& 를 먼저 치환해 이중 이스케이프가 되지 않는다', () => {
    assert.equal(escapeHtml('a & <b'), 'a &amp; &lt;b');
  });
});

describe('splitForTelegram', () => {
  test('한도 안이면 그대로 하나', () => {
    assert.deepEqual(splitForTelegram('짧음'), ['짧음']);
  });

  test('줄 경계에서 나누고 모든 조각이 한도 이하', () => {
    const text = Array.from({ length: 500 }, (_, i) => `줄 ${i} ${'가'.repeat(20)}`).join('\n');
    const parts = splitForTelegram(text);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= TELEGRAM_LIMIT));
    // 줄 내용이 유실되지 않는다.
    assert.equal(parts.join('\n').replaceAll('\n', ''), text.replaceAll('\n', ''));
  });

  test('한 줄이 한도를 넘으면 그 줄을 강제로 쪼갠다', () => {
    const parts = splitForTelegram('가'.repeat(TELEGRAM_LIMIT + 100));
    assert.equal(parts.length, 2);
    assert.ok(parts.every((part) => part.length <= TELEGRAM_LIMIT));
  });

  test('앞에 쌓인 내용과 긴 줄이 섞여도 잃지 않는다', () => {
    const parts = splitForTelegram(`머리말\n${'나'.repeat(TELEGRAM_LIMIT + 10)}`, TELEGRAM_LIMIT);
    assert.equal(parts[0], '머리말');
    assert.equal(parts.slice(1).join('').length, TELEGRAM_LIMIT + 10);
  });
});

describe('renderPreview', () => {
  test('두 섹션 제목과 내용을 담는다', () => {
    const text = renderPreview(draft, { fragmentCount: 4 });
    assert.match(text, /2026-07-26 일간 회고/);
    assert.match(text, /조각 4개/);
    assert.match(text, /오늘 한 일/);
    assert.match(text, /한 줄 배움 \/ 감정/);
    assert.match(text, /▸ <b>장바구니 개선<\/b>/);
    assert.match(text, /↳ 발견: 결제 단계가 4개/);
    assert.match(text, /staleTime 과 gcTime 을 헷갈리고 있었다/);
  });

  test('분류 못 한 항목을 경고와 함께 보여준다', () => {
    const text = renderPreview(draft, { fragmentCount: 4 });
    assert.match(text, /분류 못 한 1건/);
    assert.match(text, /알 수 없는 조각/);
  });

  test('group 이 null 이면 소제목 줄을 넣지 않는다', () => {
    const text = renderPreview(draft, { fragmentCount: 4 });
    assert.match(text, /• 커피 2잔/);
    assert.equal(text.includes('▸ <b>null</b>'), false);
  });

  test('note 가 있으면 맨 위에 경고로 붙는다', () => {
    const text = renderPreview(draft, { fragmentCount: 1, note: '자동 정리 실패' });
    assert.match(text, /⚠️ 자동 정리 실패/);
  });

  test('내용이 하나도 없으면 그렇다고 말한다', () => {
    const text = renderPreview({ date: '2026-07-26', done: [], learnings: [], dropped: [] }, { fragmentCount: 0 });
    assert.match(text, /정리된 내용이 없습니다/);
  });

  test('사용자 텍스트의 HTML 은 이스케이프된다', () => {
    const text = renderPreview(
      { date: '2026-07-26', done: [{ group: '<script>', bullets: [{ text: 'a < b', sub: [] }] }], learnings: [], dropped: [] },
      { fragmentCount: 1 },
    );
    assert.match(text, /&lt;script&gt;/);
    assert.match(text, /a &lt; b/);
  });
});

describe('previewKeyboard', () => {
  test('네 버튼에 토큰을 심는다', () => {
    const rows = previewKeyboard('abc123').inline_keyboard.flat();
    assert.deepEqual(
      rows.map((button) => button.callback_data),
      ['save:abc123', 'redo:abc123', 'raw:abc123', 'cancel:abc123'],
    );
  });
});

describe('renderFragments', () => {
  test('비어 있으면 안내 문구', () => {
    assert.match(renderFragments([]), /쌓인 조각이 없습니다/);
  });

  test('번호와 시각을 붙이고 원문을 이스케이프한다', () => {
    const text = renderFragments([{ ts: '2026-07-26T14:03:00+09:00', text: '<b>원문</b>' }]);
    assert.match(text, /<b>1\.<\/b>/);
    assert.match(text, /&lt;b&gt;원문&lt;\/b&gt;/);
  });
});
