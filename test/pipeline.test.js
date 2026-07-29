process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { SECTIONS } from '../src/blocks.js';
import { Pipeline } from '../src/pipeline.js';
import { Queue } from '../src/queue.js';

const CHAT_ID = '555';

const DRAFT = {
  date: '2026-07-26',
  done: [{ group: '장바구니 개선', bullets: [{ text: '담기 버튼 버그 수정', sub: [] }] }],
  learnings: [{ text: 'staleTime 과 gcTime 을 헷갈리고 있었다', sub: [] }],
  dropped: [],
};

class FakeTelegram {
  constructor() {
    this.sent = [];
    this.answers = [];
    this.cleared = [];
    this.nextMessageId = 100;
  }
  async sendLong(chatId, text, options = {}) {
    this.sent.push({ text, options });
    return { message_id: (this.nextMessageId += 1) };
  }
  async answerCallbackQuery(id, options = {}) {
    this.answers.push(options);
  }
  async clearKeyboard(chatId, messageId) {
    this.cleared.push(messageId);
  }
  get lastText() {
    return this.sent.at(-1)?.text ?? '';
  }
  get allText() {
    return this.sent.map((s) => s.text).join('\n');
  }
}

class FakeNotion {
  constructor({ failOnSection = null } = {}) {
    this.calls = [];
    this.failOnSection = failOnSection;
    this.counter = 0;
    this.deleted = [];
  }
  async findDailyPage() {
    return null;
  }
  async pageText() {
    return '';
  }
  async findOrCreateDailyPage(dateString) {
    this.calls.push({ op: 'findOrCreate', dateString });
    return { page: { id: 'page1', url: 'https://notion.so/page1' }, created: true };
  }
  async appendToSection(pageId, title, blocks) {
    if (!blocks.length) return [];
    this.calls.push({ op: 'append', title, count: blocks.length });
    if (this.failOnSection === title) throw new Error(`${title} 저장 실패`);
    return blocks.map(() => `blk-${(this.counter += 1)}`);
  }
  async deleteBlocks(ids) {
    this.deleted.push(...ids);
    return [];
  }
  get appendedSections() {
    return this.calls.filter((c) => c.op === 'append').map((c) => c.title);
  }
}

const fakeComposer = (result = { draft: DRAFT, ok: true }) => ({
  compose: async () => result,
});

const fragment = (id, text = `조각 ${id}`, ts = '2026-07-26T14:00:00+09:00') => ({
  id,
  ts,
  text,
  messageId: id,
});

/** 특정 날짜에 쓴 조각 */
const writtenOn = (id, isoDate, time = 'T14:00:00+09:00') =>
  fragment(id, `${isoDate} 조각`, `${isoDate}${time}`);

const callback = (data, messageId = 101) => ({ id: 'cb1', data, message: { message_id: messageId } });

let dir;
let queue;
let telegram;
let notion;

function makePipeline({ composer = fakeComposer(), notionImpl } = {}) {
  notion = notionImpl ?? new FakeNotion();
  telegram = new FakeTelegram();
  queue = new Queue({ dir });
  return new Pipeline({
    config: {
      telegram: { chatId: CHAT_ID },
      dataDir: dir,
      digestTime: { hour: 23, minute: 0 },
      cutoffHour: 4,
    },
    telegram,
    notion,
    composer,
    queue,
    logger: { error() {}, log() {} },
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retro-pipeline-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runDigest', () => {
  test('큐가 비어 있으면 아무것도 만들지 않는다', async () => {
    const pipeline = makePipeline();
    await pipeline.runDigest({ trigger: 'manual' });

    assert.match(telegram.lastText, /쌓인 조각이 없습니다/);
    assert.equal(await pipeline.pending.read(), null);
  });

  test('미리보기를 보내고 pending 에 스냅샷을 남긴다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await queue.append(fragment(2));

    await pipeline.runDigest({ trigger: 'manual' });

    const preview = telegram.sent.at(-1);
    assert.match(preview.text, /오늘 한 일/);
    assert.ok(preview.options.reply_markup, '인라인 키보드가 붙어야 한다');

    const pending = await pipeline.pending.read();
    assert.equal(pending.fragments.length, 2);
    // 회고 날짜는 "지금"이 아니라 조각의 ts 에서 나온다.
    assert.equal(pending.retroDate, '2026-07-26');

    // 승인 전에는 큐를 건드리지 않는다.
    assert.equal(await queue.size(), 2);
  });

  test('승인 대기 중이면 새 정리를 시작하지 않는다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const sentBefore = telegram.sent.length;

    await pipeline.runDigest({ trigger: 'manual' });

    assert.match(telegram.lastText, /아직 승인하지 않은 정리가 있습니다/);
    assert.equal(telegram.sent.length, sentBefore + 1);
  });

  test('정리가 실패하면 큐를 유지하고 원인을 알린다', async () => {
    const pipeline = makePipeline({
      composer: {
        compose: async () => {
          throw new Error('claude 폭발');
        },
      },
    });
    await queue.append(fragment(1));

    await pipeline.runDigest({ trigger: 'manual' });

    assert.match(telegram.lastText, /정리 중 오류/);
    assert.match(telegram.lastText, /claude 폭발/);
    assert.equal(await queue.size(), 1);
    assert.equal(await pipeline.pending.read(), null);
  });
});

describe('save', () => {
  test('두 섹션에 넣고 큐를 비우고 pending 을 해제한다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`save:${token}`));

    assert.deepEqual(notion.appendedSections, [SECTIONS.done.title, SECTIONS.learnings.title]);
    assert.equal(await queue.size(), 0);
    assert.equal(await pipeline.pending.read(), null);

    const lastWrite = await pipeline.lastWrite.read();
    assert.equal(lastWrite.pageId, 'page1');
    assert.ok(lastWrite.blockIds.length > 0);
    assert.match(telegram.lastText, /저장했습니다/);
  });

  test('정리 중에 들어온 조각은 저장 후에도 큐에 남는다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });

    // 승인 버튼을 누르기 전에 새 생각이 떠올랐다.
    await queue.append(fragment(99, '방금 떠오른 생각'));

    const { token } = await pipeline.pending.read();
    await pipeline.handleCallback(callback(`save:${token}`));

    const remaining = await queue.readAll();
    assert.deepEqual(remaining.map((f) => f.id), [99]);
    assert.match(telegram.lastText, /큐에 남은 조각: 7월 26일 \(일\) 1개/);
  });

  test('저장이 실패하면 큐와 pending 을 그대로 두고 재시도 버튼을 준다', async () => {
    const pipeline = makePipeline({ notionImpl: new FakeNotion({ failOnSection: SECTIONS.done.title }) });
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`save:${token}`));

    assert.match(telegram.lastText, /노션 저장에 실패했습니다/);
    assert.ok(telegram.sent.at(-1).options.reply_markup, '재시도 버튼이 있어야 한다');
    assert.equal(await queue.size(), 1);
    assert.equal((await pipeline.pending.read())?.token, token);
  });

  test('두 번째 섹션에서 실패한 뒤 재시도하면 첫 섹션을 중복 삽입하지 않는다', async () => {
    const flaky = new FakeNotion({ failOnSection: SECTIONS.learnings.title });
    const pipeline = makePipeline({ notionImpl: flaky });
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`save:${token}`));
    assert.deepEqual(flaky.appendedSections, [SECTIONS.done.title, SECTIONS.learnings.title]);

    const afterFailure = await pipeline.pending.read();
    assert.equal(afterFailure.progress.done, true);
    assert.equal(afterFailure.progress.learnings, false);

    // 이제 노션이 정상으로 돌아왔다고 하고 재시도한다.
    flaky.failOnSection = null;
    await pipeline.handleCallback(callback(`save:${token}`));

    const doneAppends = flaky.appendedSections.filter((t) => t === SECTIONS.done.title);
    assert.equal(doneAppends.length, 1, '오늘 한 일 섹션은 한 번만 삽입돼야 한다');
    assert.equal(await queue.size(), 0);
    assert.equal(await pipeline.pending.read(), null);
  });
});

describe('cancel / raw / 만료', () => {
  test('취소하면 큐를 남기고 pending 만 지운다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`cancel:${token}`));

    assert.equal(await pipeline.pending.read(), null);
    assert.equal(await queue.size(), 1);
    assert.match(telegram.lastText, /저장하지 않았습니다/);
  });

  test('부분 저장 후 취소하면 이미 들어간 블록을 알려준다', async () => {
    const pipeline = makePipeline({ notionImpl: new FakeNotion({ failOnSection: SECTIONS.learnings.title }) });
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`save:${token}`));
    await pipeline.handleCallback(callback(`cancel:${token}`));

    assert.match(telegram.lastText, /이미 노션에 들어갔습니다/);
  });

  test('원문 보기는 조각 원문을 보여준다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1, '원문 그대로'));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();

    await pipeline.handleCallback(callback(`raw:${token}`));

    assert.match(telegram.lastText, /원문 그대로/);
    assert.equal((await pipeline.pending.read())?.token, token, 'pending 은 유지된다');
  });

  test('만료된 토큰은 거부하고 버튼을 떼어낸다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });

    await pipeline.handleCallback(callback('save:엉뚱한토큰'));

    assert.match(telegram.answers.at(-1).text, /만료된 미리보기/);
    assert.equal(await queue.size(), 1);
    assert.equal(notion.appendedSections.length, 0);
  });
});

describe('undo', () => {
  test('블록을 지우고 조각을 큐에 되돌린다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1));
    await pipeline.runDigest({ trigger: 'manual' });
    const { token } = await pipeline.pending.read();
    await pipeline.handleCallback(callback(`save:${token}`));

    const { blockIds } = await pipeline.lastWrite.read();
    await pipeline.undo();

    assert.deepEqual(notion.deleted, blockIds);
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [1]);
    assert.equal(await pipeline.lastWrite.read(), null);
    assert.match(telegram.lastText, /되돌렸습니다/);
  });

  test('되돌릴 기록이 없으면 그렇다고 말한다', async () => {
    const pipeline = makePipeline();
    await pipeline.undo();
    assert.match(telegram.lastText, /되돌릴 저장 기록이 없습니다/);
  });
});

describe('잠자기로 밀린 날짜 처리', () => {
  test('월요일 밤에 덮고 화요일 아침에 열면 월요일 몫이 월요일 페이지로 간다', async () => {
    const pipeline = makePipeline();
    // 월요일에 쓴 조각들이 큐에 남은 채로 맥이 잤다.
    await queue.append(writtenOn(1, '2026-07-27', 'T10:00:00+09:00'));
    await queue.append(writtenOn(2, '2026-07-27', 'T21:30:00+09:00'));
    // 화요일 아침에 깨어났다.
    pipeline.now = () => new Date(2026, 6, 28, 9, 0);

    assert.equal(await pipeline.maybeRunDigest(), true);

    const pending = await pipeline.pending.read();
    assert.equal(pending.retroDate, '2026-07-27', '화요일이 아니라 월요일이어야 한다');

    await pipeline.handleCallback(callback(`save:${pending.token}`));
    assert.equal(notion.calls[0].dateString, '2026-07-27');
  });

  test('새벽에 쓴 조각은 전날 몫으로 함께 묶인다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27', 'T21:00:00+09:00'));
    await queue.append(writtenOn(2, '2026-07-28', 'T02:00:00+09:00'));
    pipeline.now = () => new Date(2026, 6, 28, 9, 0);

    await pipeline.maybeRunDigest();

    const pending = await pipeline.pending.read();
    assert.equal(pending.retroDate, '2026-07-27');
    assert.equal(pending.fragments.length, 2, '새벽 2시 조각도 월요일 몫이다');
  });

  test('며칠 밀리면 오래된 날짜부터 하나씩, 승인할 때마다 이어서 나온다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27'));
    await queue.append(writtenOn(2, '2026-07-28'));
    await queue.append(writtenOn(3, '2026-07-29'));
    pipeline.now = () => new Date(2026, 6, 30, 9, 0);

    const processed = [];
    for (let round = 0; round < 3; round += 1) {
      assert.equal(await pipeline.maybeRunDigest(), true, `${round + 1}회차가 돌아야 한다`);
      const pending = await pipeline.pending.read();
      processed.push(pending.retroDate);
      await pipeline.handleCallback(callback(`save:${pending.token}`));
    }

    assert.deepEqual(processed, ['2026-07-27', '2026-07-28', '2026-07-29']);
    assert.equal(await queue.size(), 0);
    // 날짜마다 별도 페이지를 찾는다.
    assert.deepEqual(
      notion.calls.filter((c) => c.op === 'findOrCreate').map((c) => c.dateString),
      ['2026-07-27', '2026-07-28', '2026-07-29'],
    );
  });

  test('한 날짜를 저장해도 다른 날짜 조각은 큐에 남는다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27'));
    await queue.append(writtenOn(2, '2026-07-28'));
    pipeline.now = () => new Date(2026, 6, 30, 9, 0);

    await pipeline.maybeRunDigest();
    const { token } = await pipeline.pending.read();
    await pipeline.handleCallback(callback(`save:${token}`));

    assert.deepEqual((await queue.readAll()).map((f) => f.id), [2]);
    assert.match(telegram.lastText, /큐에 남은 조각/);
  });

  test('아직 임계 시각이 안 된 오늘 몫은 함께 나가지 않는다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27'));
    await queue.append(writtenOn(2, '2026-07-28'));
    // 화요일 오전 — 화요일 23:00 은 아직 오지 않았다.
    pipeline.now = () => new Date(2026, 6, 28, 9, 0);

    await pipeline.maybeRunDigest();

    const pending = await pipeline.pending.read();
    assert.equal(pending.retroDate, '2026-07-27');
    assert.deepEqual(pending.fragments.map((f) => f.id), [1], '화요일 조각은 섞이지 않는다');
  });

  test('/now 는 임계 시각을 무시하고 가장 오래된 날짜부터 정리한다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27'));
    await queue.append(writtenOn(2, '2026-07-28'));
    pipeline.now = () => new Date(2026, 6, 28, 9, 0);

    await pipeline.runDigest();

    const pending = await pipeline.pending.read();
    assert.equal(pending.retroDate, '2026-07-27');
    assert.match(telegram.allText, /다른 날짜 1일이 더 밀려 있습니다/);
  });

  test('/now 는 취소한 날짜도 다시 정리해준다', async () => {
    const pipeline = makePipeline();
    await queue.append(writtenOn(1, '2026-07-27'));
    pipeline.now = () => new Date(2026, 6, 28, 9, 0);

    await pipeline.maybeRunDigest();
    const first = await pipeline.pending.read();
    await pipeline.handleCallback(callback(`cancel:${first.token}`));

    // 스케줄러는 이미 보여준 날짜를 건너뛴다.
    assert.equal(await pipeline.maybeRunDigest(), false);

    // 사람이 직접 부르면 다시 해준다.
    await pipeline.runDigest();
    assert.equal((await pipeline.pending.read())?.retroDate, '2026-07-27');
  });

  test('ts 가 깨진 조각도 유실되지 않고 오늘 몫으로 들어간다', async () => {
    const pipeline = makePipeline();
    await queue.append(fragment(1, '깨진 타임스탬프', '이건 날짜가 아니다'));
    pipeline.now = () => new Date(2026, 6, 28, 23, 30);

    assert.equal(await pipeline.maybeRunDigest(), true);
    assert.equal((await pipeline.pending.read())?.retroDate, '2026-07-28');
  });
});

describe('maybeRunDigest — 스케줄러', () => {
  test('정리 시각 전에는 돌지 않는다', async () => {
    const pipeline = makePipeline();
    pipeline.now = () => new Date(2026, 6, 26, 21, 0);
    await queue.append(fragment(1));

    assert.equal(await pipeline.maybeRunDigest(), false);
    assert.equal(telegram.sent.length, 0);
  });

  test('정리 시각이 지나면 한 번만 돈다', async () => {
    const pipeline = makePipeline();
    pipeline.now = () => new Date(2026, 6, 26, 23, 5);
    await queue.append(fragment(1));

    assert.equal(await pipeline.maybeRunDigest(), true);
    assert.ok(await pipeline.pending.read());

    // 30초 뒤 다음 틱 — 이미 보냈으므로 다시 보내지 않는다.
    const sentAfterFirst = telegram.sent.length;
    assert.equal(await pipeline.maybeRunDigest(), false);
    assert.equal(telegram.sent.length, sentAfterFirst);
  });

  test('취소한 뒤에도 스케줄러가 같은 날 다시 들이밀지 않는다', async () => {
    const pipeline = makePipeline();
    pipeline.now = () => new Date(2026, 6, 26, 23, 5);
    await queue.append(fragment(1));
    await pipeline.maybeRunDigest();

    const { token } = await pipeline.pending.read();
    await pipeline.handleCallback(callback(`cancel:${token}`));

    assert.equal(await pipeline.maybeRunDigest(), false);
  });
});
