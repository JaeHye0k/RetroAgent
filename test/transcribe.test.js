import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Transcriber, TranscribeError } from '../src/transcribe.js';

/** { text } 를 돌려주는 가짜 Groq — 요청 내용을 뜯어볼 수 있게 호출을 기록한다. */
const okFetch = (text = '안녕하세요') => {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ text }) };
  };
  impl.calls = calls;
  return impl;
};

/** signal 이 끊길 때까지 매달리는 fetch — 죽은 소켓을 흉내낸다. */
const hangingFetch = async (url, options) =>
  new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });

describe('Transcriber', () => {
  test('오디오를 텍스트로 바꾸고 결과를 다듬어 돌려준다', async () => {
    const fetchImpl = okFetch('  오늘 회고 조각  ');
    const t = new Transcriber({ apiKey: 'gsk_test', fetchImpl });

    const text = await t.transcribe(new Uint8Array([1, 2, 3]));
    assert.equal(text, '오늘 회고 조각');
  });

  test('모델·언어·인증 헤더를 요청에 실어 보낸다', async () => {
    const fetchImpl = okFetch();
    const t = new Transcriber({ apiKey: 'gsk_test', model: 'whisper-large-v3', language: 'ko', fetchImpl });

    await t.transcribe(new Uint8Array([1, 2, 3]), { filename: 'note.oga', mimeType: 'audio/ogg' });

    const { url, options } = fetchImpl.calls[0];
    assert.match(url, /groq\.com/);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer gsk_test');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('model'), 'whisper-large-v3');
    assert.equal(options.body.get('language'), 'ko');
    assert.ok(options.body.get('file'), '오디오 파일이 실려야 한다');
  });

  test('language 가 비면 요청에 넣지 않는다', async () => {
    const fetchImpl = okFetch();
    const t = new Transcriber({ apiKey: 'gsk_test', language: '', fetchImpl });

    await t.transcribe(new Uint8Array([1]));
    assert.equal(fetchImpl.calls[0].options.body.get('language'), null);
  });

  test('키가 없으면 요청을 시작하지도 않는다', async () => {
    let called = false;
    const t = new Transcriber({ apiKey: '', fetchImpl: async () => ((called = true), {}) });

    await assert.rejects(() => t.transcribe(new Uint8Array([1])), TranscribeError);
    assert.equal(called, false, '키가 없으면 네트워크를 건드리지 않아야 한다');
  });

  test('enabled 는 키 유무를 반영한다', () => {
    assert.equal(new Transcriber({ apiKey: 'gsk_x' }).enabled, true);
    assert.equal(new Transcriber({ apiKey: '' }).enabled, false);
  });

  test('비-200 응답을 TranscribeError 로 바꾸고 상세를 담는다', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API Key' } }),
    });
    const t = new Transcriber({ apiKey: 'gsk_bad', fetchImpl });

    await assert.rejects(
      () => t.transcribe(new Uint8Array([1])),
      (error) => {
        assert.ok(error instanceof TranscribeError);
        assert.equal(error.status, 401);
        assert.match(error.message, /Invalid API Key/);
        return true;
      },
    );
  });

  test('JSON 이 아닌 응답도 TranscribeError 로 바꾼다', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    const t = new Transcriber({ apiKey: 'gsk_x', fetchImpl });

    await assert.rejects(() => t.transcribe(new Uint8Array([1])), /JSON 으로 읽지 못했습니다/);
  });

  test('응답이 없으면 끊고 TranscribeError 를 던진다', async () => {
    const t = new Transcriber({ apiKey: 'gsk_x', fetchImpl: hangingFetch, timeoutMs: 50 });

    await assert.rejects(
      () => t.transcribe(new Uint8Array([1])),
      (error) => {
        assert.ok(error instanceof TranscribeError);
        assert.match(error.message, /50ms 안에 인식 응답이 없어 끊었습니다/);
        return true;
      },
    );
  });

  test('텍스트가 비면 빈 문자열을 돌려준다', async () => {
    const t = new Transcriber({ apiKey: 'gsk_x', fetchImpl: okFetch('') });
    assert.equal(await t.transcribe(new Uint8Array([1])), '');
  });
});
