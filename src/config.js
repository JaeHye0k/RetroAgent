import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const REQUIRED = {
  TELEGRAM_BOT_TOKEN: '@BotFather 에서 발급한 봇 토큰',
  TELEGRAM_CHAT_ID: '본인 텔레그램 chat id (`npm run whoami` 로 확인)',
  NOTION_TOKEN: 'Notion Internal Integration 토큰 (ntn_...)',
  NOTION_DB_ID: '회고 데이터베이스 id',
};

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

  const cutoffHour = Number(env.DAY_CUTOFF_HOUR ?? 4);
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 12) {
    throw new ConfigError(`DAY_CUTOFF_HOUR 는 0~12 사이 정수여야 합니다: "${env.DAY_CUTOFF_HOUR}"`);
  }

  return {
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN.trim(),
      chatId: String(env.TELEGRAM_CHAT_ID).trim(),
    },
    notion: {
      token: env.NOTION_TOKEN.trim(),
      dbId: normalizeNotionId(env.NOTION_DB_ID),
    },
    digestTime: parseTimeOfDay(env.DIGEST_TIME ?? '23:00', 'DIGEST_TIME'),
    cutoffHour,
    claude: {
      bin: (env.CLAUDE_BIN ?? 'claude').trim(),
      model: (env.CLAUDE_MODEL ?? 'sonnet').trim(),
      timeoutMs: Number(env.COMPOSE_TIMEOUT_MS ?? 240_000),
    },
    dataDir: DATA_DIR,
  };
}
