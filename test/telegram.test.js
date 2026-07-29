import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Telegram, TelegramError } from '../src/telegram.js';

/** signal 이 끊길 때까지 영원히 매달리는 fetch — 잠자기에서 깨어난 죽은 소켓을 흉내낸다. */
const hangingFetch = async (url, options) =>
  new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });

const okFetch = (result = true) => {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  impl.calls = calls;
  return impl;
};

describe('타임아웃 — 잠자기에서 깨어날 때 조용히 멎지 않는다', () => {
  test('응답이 없으면 끊고 TelegramError 를 던진다', async () => {
    const telegram = new Telegram({ token: 't', fetchImpl: hangingFetch, timeoutMs: 50 });

    await assert.rejects(
      () => telegram.call('getMe'),
      (error) => {
        assert.ok(error instanceof TelegramError, 'TelegramError 여야 폴링 루프가 백오프로 잡는다');
        assert.match(error.message, /50ms 안에 응답이 없어 끊었습니다/);
        return true;
      },
    );
  });

  test('모든 요청에 signal 이 붙는다', async () => {
    const fetchImpl = okFetch();
    const telegram = new Telegram({ token: 't', fetchImpl });

    await telegram.sendMessage('1', '안녕');
    assert.ok(fetchImpl.calls[0].options.signal instanceof AbortSignal);
  });

  test('long-polling 은 폴링 시간보다 넉넉한 한도를 쓴다', async () => {
    // timeout=0 초라도 끊는 한도는 15초다. 정상 long-poll 을 오인해 끊으면 안 된다.
    const telegram = new Telegram({ token: 't', fetchImpl: hangingFetch, timeoutMs: 50 });

    const settled = await Promise.race([
      telegram.getUpdates({ offset: 1, timeout: 0 }).then(() => 'settled', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 200)),
    ]);

    assert.equal(settled, 'pending', '기본 20ms/50ms 한도가 아니라 폴링 기준 한도를 써야 한다');
  });

  test('일반 요청은 기본 한도를 쓴다', async () => {
    const telegram = new Telegram({ token: 't', fetchImpl: hangingFetch, timeoutMs: 40 });
    await assert.rejects(() => telegram.sendMessage('1', 'x'), /40ms/);
  });
});

describe('call', () => {
  test('ok:false 응답을 TelegramError 로 바꾼다', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    });
    const telegram = new Telegram({ token: 't', fetchImpl });

    await assert.rejects(() => telegram.sendMessage('1', 'x'), /chat not found/);
  });

  test('JSON 이 아닌 응답도 TelegramError 로 바꾼다', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    const telegram = new Telegram({ token: 't', fetchImpl });

    await assert.rejects(() => telegram.sendMessage('1', 'x'), /응답을 JSON 으로 읽지 못했습니다/);
  });

  test('getUpdates 는 message 와 callback_query 만 받는다', async () => {
    const fetchImpl = okFetch([]);
    const telegram = new Telegram({ token: 't', fetchImpl });

    await telegram.getUpdates({ offset: 7, timeout: 50 });
    assert.deepEqual(fetchImpl.calls[0].body.allowed_updates, ['message', 'callback_query']);
    assert.equal(fetchImpl.calls[0].body.offset, 7);
  });
});

describe('sendLong', () => {
  test('나눠 보낼 때 키보드는 마지막 조각에만 붙인다', async () => {
    const fetchImpl = okFetch({ message_id: 1 });
    const telegram = new Telegram({ token: 't', fetchImpl });

    const long = Array.from({ length: 400 }, (_, i) => `줄 ${i} ${'가'.repeat(20)}`).join('\n');
    await telegram.sendLong('1', long, { reply_markup: { inline_keyboard: [] } });

    assert.ok(fetchImpl.calls.length > 1, '나눠 보내야 한다');
    for (const call of fetchImpl.calls.slice(0, -1)) {
      assert.equal(call.body.reply_markup, undefined);
    }
    assert.ok(fetchImpl.calls.at(-1).body.reply_markup);
  });
});

describe('react', () => {
  test('리액션이 실패해도 본 흐름을 막지 않는다', async () => {
    const telegram = new Telegram({
      token: 't',
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: '불가' }) }),
    });

    assert.equal(await telegram.react('1', 2, '👌'), false);
  });
});
