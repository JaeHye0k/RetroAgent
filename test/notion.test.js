import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { bullet, SECTIONS } from '../src/blocks.js';
import { Notion, pageUrl } from '../src/notion.js';

const heading = (id, title) => ({ id, type: 'heading_2', heading_2: { rich_text: [{ plain_text: title }] } });
const quote = (id, text) => ({ id, type: 'quote', quote: { rich_text: [{ plain_text: text }] } });
const listItem = (id, text) => ({
  id,
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: [{ plain_text: text }] },
});
const dividerBlock = (id) => ({ id, type: 'divider', divider: {} });

/** 응답 큐를 순서대로 돌려주는 가짜 fetch. 호출 기록을 남긴다. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      signal: options.signal,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (key) => next.headers?.[key] ?? null },
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const notionWith = (responses) =>
  new Notion({ token: 't', dbId: 'db', fetchImpl: fakeFetch(responses), maxRetries: 2 });

describe('appendToSection — 섹션 끝에 정확히 끼워넣는다', () => {
  test('구분선 직전 마지막 블록을 기준점으로 삼는다', async () => {
    const children = [
      heading('h1', SECTIONS.done.title),
      quote('q1', '가이드'),
      listItem('b1', '기존 항목'),
      dividerBlock('d1'),
      heading('h2', SECTIONS.learnings.title),
      quote('q2', '가이드'),
    ];
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: children, has_more: false } },
      { status: 200, body: { results: [{ id: 'new1' }] } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    const ids = await notion.appendToSection('page', SECTIONS.done.title, [bullet('새 항목')]);

    assert.deepEqual(ids, ['new1']);
    const patch = fetchImpl.calls.at(-1);
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.body.after, 'b1', '기존 항목 뒤에 붙어야 한다');
  });

  test('섹션이 비어 있으면 가이드 문구 뒤에 붙는다', async () => {
    const children = [
      heading('h1', SECTIONS.done.title),
      quote('q1', '가이드'),
      dividerBlock('d1'),
      heading('h2', SECTIONS.learnings.title),
      quote('q2', '가이드'),
    ];
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: children, has_more: false } },
      { status: 200, body: { results: [{ id: 'new1' }] } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    await notion.appendToSection('page', SECTIONS.done.title, [bullet('새 항목')]);
    assert.equal(fetchImpl.calls.at(-1).body.after, 'q1');
  });

  test('구분선이 없어도 다음 헤딩 직전에서 멈춘다', async () => {
    const children = [
      heading('h1', SECTIONS.done.title),
      listItem('b1', '기존'),
      heading('h2', SECTIONS.learnings.title),
      listItem('b2', '배움'),
    ];
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: children, has_more: false } },
      { status: 200, body: { results: [{ id: 'new1' }] } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    await notion.appendToSection('page', SECTIONS.done.title, [bullet('새 항목')]);
    assert.equal(fetchImpl.calls.at(-1).body.after, 'b1');
  });

  test('마지막 섹션이면 페이지 맨 끝 블록을 기준점으로 삼는다', async () => {
    const children = [
      heading('h1', SECTIONS.done.title),
      dividerBlock('d1'),
      heading('h2', SECTIONS.learnings.title),
      listItem('b2', '기존 배움'),
    ];
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: children, has_more: false } },
      { status: 200, body: { results: [{ id: 'new1' }] } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    await notion.appendToSection('page', SECTIONS.learnings.title, [bullet('새 배움')]);
    assert.equal(fetchImpl.calls.at(-1).body.after, 'b2');
  });

  test('섹션 헤딩이 없으면 헤딩·가이드를 함께 만들어 붙인다', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: [listItem('b1', '아무 내용')], has_more: false } },
      { status: 200, body: { results: [{ id: 'h_new' }, { id: 'q_new' }, { id: 'new1' }] } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    await notion.appendToSection('page', SECTIONS.learnings.title, [bullet('새 배움')]);

    const patch = fetchImpl.calls.at(-1);
    assert.equal(patch.body.after, undefined, '기준점 없이 페이지 끝에 붙는다');
    assert.deepEqual(patch.body.children.map((b) => b.type), ['heading_2', 'quote', 'bulleted_list_item']);
    // 해당 섹션의 가이드 문구만 들어가야 한다.
    assert.equal(patch.body.children[1].quote.rich_text[0].text.content, SECTIONS.learnings.guide);
  });

  test('빈 블록 배열이면 API 를 아예 부르지 않는다', async () => {
    const fetchImpl = fakeFetch([]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });
    assert.deepEqual(await notion.appendToSection('page', SECTIONS.done.title, []), []);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('listChildren 페이지네이션', () => {
  test('has_more 면 커서를 따라 계속 읽는다', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { results: [listItem('a', 'a')], has_more: true, next_cursor: 'c1' } },
      { status: 200, body: { results: [listItem('b', 'b')], has_more: false } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    const blocks = await notion.listChildren('page');
    assert.deepEqual(blocks.map((b) => b.id), ['a', 'b']);
    assert.match(fetchImpl.calls[1].url, /start_cursor=c1/);
  });
});

describe('재시도', () => {
  test('429 면 재시도하고 성공한다', async () => {
    const fetchImpl = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'rate limited' } },
      { status: 200, body: { ok: true } },
    ]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl, maxRetries: 2 });

    assert.deepEqual(await notion.request('GET', '/x'), { ok: true });
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('400 은 재시도하지 않고 바로 던진다', async () => {
    const fetchImpl = fakeFetch([{ status: 400, body: { message: '속성이 없습니다', code: 'validation_error' } }]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl, maxRetries: 2 });

    await assert.rejects(() => notion.request('GET', '/x'), /속성이 없습니다/);
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('타임아웃도 재시도 대상이다', async () => {
    let attempts = 0;
    const fetchImpl = async (url, options) => {
      attempts += 1;
      if (attempts === 1) {
        // 잠자기에서 깨어난 죽은 소켓 — signal 이 끊는다.
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    };
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl, maxRetries: 2, timeoutMs: 50 });

    assert.deepEqual(await notion.request('GET', '/x'), { ok: true });
    assert.equal(attempts, 2, '끊긴 요청을 한 번 더 시도해야 한다');
  });

  test('계속 타임아웃이면 원인을 담아 던진다', async () => {
    const fetchImpl = async (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
      });
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl, maxRetries: 0, timeoutMs: 40 });

    await assert.rejects(() => notion.request('GET', '/x'), /40ms 안에 응답이 없어 끊었습니다/);
  });

  test('모든 요청에 signal 이 붙는다', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });
    await notion.request('GET', '/x');
    assert.ok(fetchImpl.calls.at(-1).signal instanceof AbortSignal);
  });

  test('재시도 횟수를 넘기면 마지막 오류를 던진다', async () => {
    const responses = Array.from({ length: 3 }, () => ({ status: 500, body: { message: '서버 오류' } }));
    const fetchImpl = fakeFetch(responses);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl, maxRetries: 2 });

    await assert.rejects(() => notion.request('GET', '/x'), /서버 오류/);
    assert.equal(fetchImpl.calls.length, 3);
  });
});

describe('deleteBlocks', () => {
  test('404 는 이미 지워진 것으로 보고 성공 처리한다', async () => {
    const notion = notionWith([
      { status: 200, body: {} },
      { status: 404, body: { message: 'not found' } },
    ]);
    assert.deepEqual(await notion.deleteBlocks(['a', 'b']), []);
  });

  test('그 외 실패는 목록으로 돌려준다', async () => {
    const notion = notionWith([{ status: 403, body: { message: 'forbidden' } }]);
    assert.deepEqual(await notion.deleteBlocks(['a']), ['a']);
  });
});

describe('findDailyPage', () => {
  test('날짜와 주기=일간 을 함께 걸러 조회한다', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { results: [{ id: 'p1' }] } }]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    const page = await notion.findDailyPage('2026-07-26');
    assert.equal(page.id, 'p1');

    const { and } = fetchImpl.calls[0].body.filter;
    assert.deepEqual(and[0], { property: '날짜', date: { equals: '2026-07-26' } });
    assert.deepEqual(and[1], { property: '주기', select: { equals: '일간' } });
  });

  test('결과가 없으면 null', async () => {
    const notion = notionWith([{ status: 200, body: { results: [] } }]);
    assert.equal(await notion.findDailyPage('2026-07-26'), null);
  });
});

describe('createDailyPage', () => {
  test('제목·날짜·주기와 뼈대를 함께 만든다', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { id: 'new-page' } }]);
    const notion = new Notion({ token: 't', dbId: 'db', fetchImpl });

    await notion.createDailyPage('2026-07-26');
    const body = fetchImpl.calls[0].body;

    assert.equal(body.properties['이름'].title[0].text.content, '2026.07.26 일간 회고');
    assert.deepEqual(body.properties['날짜'].date, { start: '2026-07-26' });
    assert.deepEqual(body.properties['주기'].select, { name: '일간' });
    assert.deepEqual(body.children.map((b) => b.type), ['heading_2', 'quote', 'divider', 'heading_2', 'quote']);
  });
});

describe('pageText — 중복 방지용 컨텍스트', () => {
  test('헤딩·불릿·인용을 마크다운 비슷하게 뽑는다', async () => {
    const notion = notionWith([
      {
        status: 200,
        body: {
          has_more: false,
          results: [
            heading('h1', '오늘 한 일'),
            quote('q1', '가이드'),
            listItem('b1', '기존 항목'),
            dividerBlock('d1'),
          ],
        },
      },
    ]);

    assert.equal(await notion.pageText('page'), '## 오늘 한 일\n> 가이드\n- 기존 항목\n---');
  });
});

describe('pageUrl', () => {
  test('응답의 url 을 그대로 쓴다', () => {
    assert.equal(pageUrl({ url: 'https://notion.so/abc' }), 'https://notion.so/abc');
  });

  test('url 이 없으면 id 로 만든다', () => {
    assert.equal(pageUrl({ id: 'aa-bb-cc' }), 'https://www.notion.so/aabbcc');
  });
});
