import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ConfigError, loadConfig, normalizeNotionId, parseTimeOfDay } from '../src/config.js';

const VALID = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '987654321',
  NOTION_TOKEN: 'ntn_xxx',
  NOTION_DB_ID: '11111111-2222-3333-4444-555555555555',
};

describe('parseTimeOfDay', () => {
  test('HH:MM 을 읽는다', () => {
    assert.deepEqual(parseTimeOfDay('23:00', 'DIGEST_TIME'), { hour: 23, minute: 0 });
    assert.deepEqual(parseTimeOfDay('9:05', 'DIGEST_TIME'), { hour: 9, minute: 5 });
    assert.deepEqual(parseTimeOfDay('00:00', 'DIGEST_TIME'), { hour: 0, minute: 0 });
  });

  test('잘못된 형식은 거부한다', () => {
    for (const bad of ['24:00', '23:60', '23', '이십삼시', '', '23:0']) {
      assert.throws(() => parseTimeOfDay(bad, 'DIGEST_TIME'), ConfigError, `"${bad}" 를 통과시켰다`);
    }
  });
});

describe('normalizeNotionId', () => {
  test('하이픈을 떼고 32자리 hex 로 만든다', () => {
    assert.equal(normalizeNotionId('11111111-2222-3333-4444-555555555555'), '11111111222233334444555555555555');
  });

  test('하이픈 없는 id 도 받는다', () => {
    assert.equal(normalizeNotionId('11111111222233334444555555555555'), '11111111222233334444555555555555');
  });

  test('노션 URL 에서 뽑아낸다', () => {
    assert.equal(
      normalizeNotionId('https://www.notion.so/myspace/11111111222233334444555555555555?v=abc'),
      '11111111222233334444555555555555',
    );
  });

  test('날짜가 앞에 붙은 노션 슬러그에서도 id 만 뽑는다', () => {
    // 하이픈을 먼저 제거하면 날짜와 id 가 붙어 앞 32자를 잘못 집는다.
    assert.equal(
      normalizeNotionId('https://app.notion.com/p/2026-07-24-aaaaaaaabbbbccccddddeeeeffff0000'),
      'aaaaaaaabbbbccccddddeeeeffff0000',
    );
  });

  test('id 를 찾을 수 없으면 거부한다', () => {
    assert.throws(() => normalizeNotionId('그냥 문자열'), ConfigError);
    assert.throws(() => normalizeNotionId('abc123'), ConfigError);
  });
});

describe('loadConfig', () => {
  test('필수 값이 다 있으면 설정을 만든다', () => {
    const config = loadConfig({ ...VALID });
    assert.equal(config.telegram.chatId, '987654321');
    assert.equal(config.notion.dbId, '11111111222233334444555555555555');
    assert.deepEqual(config.digestTime, { hour: 23, minute: 0 });
    assert.equal(config.cutoffHour, 4);
    assert.equal(config.claude.model, 'sonnet');
  });

  test('빠진 값을 모두 이름으로 알려준다', () => {
    try {
      loadConfig({ TELEGRAM_BOT_TOKEN: 'x' });
      assert.fail('던져야 한다');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /TELEGRAM_CHAT_ID/);
      assert.match(error.message, /NOTION_TOKEN/);
      assert.match(error.message, /NOTION_DB_ID/);
      assert.equal(error.message.includes('TELEGRAM_BOT_TOKEN'), false);
    }
  });

  test('공백만 있는 값은 없는 것으로 본다', () => {
    assert.throws(() => loadConfig({ ...VALID, NOTION_TOKEN: '   ' }), /NOTION_TOKEN/);
  });

  test('선택 값을 덮어쓸 수 있다', () => {
    const config = loadConfig({ ...VALID, DIGEST_TIME: '22:30', DAY_CUTOFF_HOUR: '0', CLAUDE_MODEL: 'opus' });
    assert.deepEqual(config.digestTime, { hour: 22, minute: 30 });
    assert.equal(config.cutoffHour, 0);
    assert.equal(config.claude.model, 'opus');
  });

  test('DAY_CUTOFF_HOUR 범위를 벗어나면 거부한다', () => {
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '13' }), /DAY_CUTOFF_HOUR/);
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '-1' }), /DAY_CUTOFF_HOUR/);
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '넷' }), /DAY_CUTOFF_HOUR/);
  });

  test('GROQ_API_KEY 는 선택값 — 없어도 설정을 만든다', () => {
    const config = loadConfig({ ...VALID });
    assert.equal(config.groq.apiKey, '');
    assert.equal(config.groq.model, 'whisper-large-v3-turbo');
    assert.equal(config.groq.language, 'ko');
    assert.equal(config.groq.timeoutMs, 60_000);
  });

  test('GROQ_API_KEY 와 STT 설정을 덮어쓸 수 있다', () => {
    const config = loadConfig({
      ...VALID,
      GROQ_API_KEY: '  gsk_abc  ',
      GROQ_STT_MODEL: 'whisper-large-v3',
      STT_LANGUAGE: 'en',
      STT_TIMEOUT_MS: '30000',
    });
    assert.equal(config.groq.apiKey, 'gsk_abc');
    assert.equal(config.groq.model, 'whisper-large-v3');
    assert.equal(config.groq.language, 'en');
    assert.equal(config.groq.timeoutMs, 30_000);
  });
});
