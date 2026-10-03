import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ConfigError, loadConfig, normalizeNotionId, parseTimeOfDay } from '../src/config.js';

/** 전부 필수다 — .env.example 을 그대로 옮긴 모양. */
const VALID = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '987654321',
  NOTION_TOKEN: 'ntn_xxx',
  NOTION_DB_ID: '11111111-2222-3333-4444-555555555555',
  DIGEST_TIME: '23:00',
  PERIODIC_DIGEST_TIME: '23:00',
  DAY_CUTOFF_HOUR: '4',
  TZ: 'Asia/Seoul',
  CLAUDE_BIN: 'claude',
  CLAUDE_MODEL: 'sonnet',
  COMPOSE_TIMEOUT_MS: '240000',
  GROQ_API_KEY: 'gsk_xxx',
  GROQ_STT_MODEL: 'whisper-large-v3-turbo',
  STT_LANGUAGE: 'ko',
  STT_TIMEOUT_MS: '60000',
};

/** VALID 에서 키 하나를 뺀 환경 */
const without = (key) => {
  const env = { ...VALID };
  delete env[key];
  return env;
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

  test('값을 바꾸면 그대로 반영된다', () => {
    const config = loadConfig({
      ...VALID,
      DIGEST_TIME: '22:30',
      PERIODIC_DIGEST_TIME: '09:00',
      DAY_CUTOFF_HOUR: '0',
      CLAUDE_MODEL: 'opus',
      GROQ_API_KEY: '  gsk_abc  ',
      STT_LANGUAGE: 'en',
      STT_TIMEOUT_MS: '30000',
    });
    assert.deepEqual(config.digestTime, { hour: 22, minute: 30 });
    assert.deepEqual(config.periodicTime, { hour: 9, minute: 0 });
    assert.equal(config.cutoffHour, 0);
    assert.equal(config.claude.model, 'opus');
    assert.equal(config.groq.apiKey, 'gsk_abc');
    assert.equal(config.groq.language, 'en');
    assert.equal(config.groq.timeoutMs, 30_000);
  });

  test('DAY_CUTOFF_HOUR 범위를 벗어나면 거부한다', () => {
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '13' }), /DAY_CUTOFF_HOUR/);
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '-1' }), /DAY_CUTOFF_HOUR/);
    assert.throws(() => loadConfig({ ...VALID, DAY_CUTOFF_HOUR: '넷' }), /DAY_CUTOFF_HOUR/);
  });

  /**
   * 기본값을 숨겨두지 않기로 했다. 예전에는 빠진 값을 조용히 메웠지만,
   * 이제는 무엇이 없는지 말하고 멈춘다.
   */
  describe('기본값 없음 — 빠지면 전부 에러', () => {
    for (const key of Object.keys(VALID)) {
      test(`${key} 가 없으면 거부한다`, () => {
        assert.throws(() => loadConfig(without(key)), new RegExp(key));
      });
    }
  });

  test('시간 형식이 틀리면 어느 변수인지 알려준다', () => {
    assert.throws(() => loadConfig({ ...VALID, PERIODIC_DIGEST_TIME: '25:00' }), /PERIODIC_DIGEST_TIME/);
  });

  test('숫자 값이 숫자가 아니면 조용히 NaN 으로 넘어가지 않는다', () => {
    assert.throws(() => loadConfig({ ...VALID, COMPOSE_TIMEOUT_MS: 'abc' }), /COMPOSE_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ...VALID, STT_TIMEOUT_MS: '0' }), /STT_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ...VALID, STT_TIMEOUT_MS: '-5' }), /STT_TIMEOUT_MS/);
  });

  test('TZ 가 올바른 시간대가 아니면 거부한다', () => {
    assert.throws(() => loadConfig({ ...VALID, TZ: 'Asia/없는도시' }), /TZ/);
    assert.equal(loadConfig({ ...VALID, TZ: 'UTC' }).timeZone, 'UTC');
  });
});
