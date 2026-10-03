import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 전부 필수다. 기본값을 숨겨두지 않는다.
 *
 * 조용히 끼워넣은 기본값으로 도는 것보다, 무엇이 비었는지 말하고 멈추는 편이 낫다.
 * .env.example 을 그대로 복사하면 모두 채워진다.
 */
const REQUIRED = {
  TELEGRAM_BOT_TOKEN: '@BotFather 에서 발급한 봇 토큰',
  TELEGRAM_CHAT_ID: '본인 텔레그램 chat id (`npm run whoami` 로 확인)',
  NOTION_TOKEN: 'Notion Internal Integration 토큰 (ntn_...)',
  NOTION_DB_ID: '회고 데이터베이스 id',
  DIGEST_TIME: '하루치를 모아 미리보기를 보낼 시각 (HH:MM)',
  PERIODIC_DIGEST_TIME: '주기 회고(주간·월간·분기·반기·연간)를 보낼 시각 (HH:MM)',
  DAY_CUTOFF_HOUR: "이 시각 이전에 보낸 조각을 '전날' 회고로 귀속 (0~12)",
  TZ: '시간대 (예: Asia/Seoul)',
  CLAUDE_BIN: 'claude CLI 실행 파일 (보통 claude)',
  CLAUDE_MODEL: '정리에 쓸 모델 (예: sonnet)',
  COMPOSE_TIMEOUT_MS: '정리 1회당 최대 대기 시간(ms)',
  GROQ_API_KEY: '음성 인식용 Groq 키 (https://console.groq.com/keys)',
  GROQ_STT_MODEL: 'STT 모델 (예: whisper-large-v3-turbo)',
  STT_LANGUAGE: 'STT 언어 (예: ko)',
  STT_TIMEOUT_MS: '인식 1회당 최대 대기 시간(ms)',
};

/** 양의 정수만 받는다. Number('abc') 가 NaN 으로 조용히 통과하는 것을 막는다. */
function positiveInt(value, field) {
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number <= 0) {
    throw new ConfigError(`${field} 는 양의 정수여야 합니다: "${value}"`);
  }
  return number;
}

function assertTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
  } catch {
    throw new ConfigError(`TZ 가 올바른 시간대가 아닙니다: "${value}" — 예: Asia/Seoul`);
  }
}

/** "23:00" → { hour: 23, minute: 0 } */
export function parseTimeOfDay(value, field) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
  if (!match) {
    throw new ConfigError(`${field} 형식이 잘못되었습니다: "${value}" — HH:MM 이어야 합니다.`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
// 앞뒤가 hex 가 아닌, 정확히 32자리인 덩어리만 잡는다. 이 경계 조건이 없으면
// '2026-07-24-aaaaaaaabbbb...' 같은 노션 슬러그에서 날짜 부분을 id 로 오인한다.
const BARE_ID_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g;

/**
 * 노션 DB id 를 32자리 hex 로 정규화한다.
 * 하이픈 포함/미포함 id, 페이지 URL 을 모두 받는다.
 * 여러 개가 잡히면 마지막 것을 쓴다 — URL 에서는 id 가 끝에 온다.
 */
export function normalizeNotionId(raw) {
  const text = String(raw).trim().replace(/[?#].*$/, '');

  const uuids = text.match(UUID_RE);
  if (uuids?.length) return uuids.at(-1).replaceAll('-', '').toLowerCase();

  const bare = text.match(BARE_ID_RE);
  if (bare?.length) return bare.at(-1).toLowerCase();

  throw new ConfigError(`NOTION_DB_ID 에서 노션 id 를 찾지 못했습니다: "${raw}"`);
}

export function loadConfig(env = process.env) {
  const missing = Object.keys(REQUIRED).filter((key) => !String(env[key] ?? '').trim());
  if (missing.length) {
    throw new ConfigError(
      ['.env 에 다음 값이 없습니다:', ...missing.map((k) => `  · ${k} — ${REQUIRED[k]}`)].join('\n'),
    );
  }

  const cutoffHour = Number(String(env.DAY_CUTOFF_HOUR).trim());
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 12) {
    throw new ConfigError(`DAY_CUTOFF_HOUR 는 0~12 사이 정수여야 합니다: "${env.DAY_CUTOFF_HOUR}"`);
  }
  assertTimeZone(env.TZ);

  return {
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN.trim(),
      chatId: String(env.TELEGRAM_CHAT_ID).trim(),
    },
    notion: {
      token: env.NOTION_TOKEN.trim(),
      dbId: normalizeNotionId(env.NOTION_DB_ID),
    },
    digestTime: parseTimeOfDay(env.DIGEST_TIME, 'DIGEST_TIME'),
    periodicTime: parseTimeOfDay(env.PERIODIC_DIGEST_TIME, 'PERIODIC_DIGEST_TIME'),
    cutoffHour,
    timeZone: env.TZ.trim(),
    claude: {
      bin: env.CLAUDE_BIN.trim(),
      model: env.CLAUDE_MODEL.trim(),
      timeoutMs: positiveInt(env.COMPOSE_TIMEOUT_MS, 'COMPOSE_TIMEOUT_MS'),
    },
    groq: {
      apiKey: env.GROQ_API_KEY.trim(),
      model: env.GROQ_STT_MODEL.trim(),
      language: env.STT_LANGUAGE.trim(),
      timeoutMs: positiveInt(env.STT_TIMEOUT_MS, 'STT_TIMEOUT_MS'),
    },
    dataDir: DATA_DIR,
  };
}
