import path from 'node:path';
import { handleCommand } from './commands.js';
import { Composer } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { Notion } from './notion.js';
import { Pipeline } from './pipeline.js';
import { Queue } from './queue.js';
import { JsonStore } from './store.js';
import { Telegram } from './telegram.js';

const POLL_TIMEOUT_SECONDS = 50;
const SCHEDULER_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n설정 오류\n${error.message}\n\n.env.example 을 참고해 .env 를 채워주세요.\n`);
      process.exit(1);
    }
    throw error;
  }

  const telegram = new Telegram({ token: config.telegram.token });
  const notion = new Notion({ token: config.notion.token, dbId: config.notion.dbId });
  const composer = new Composer(config.claude);
  const queue = new Queue({ dir: config.dataDir });
  const pipeline = new Pipeline({ config, telegram, notion, composer, queue });
  const offsetStore = new JsonStore(path.join(config.dataDir, 'offset.json'), { offset: 0 });

  const me = await telegram.getMe();
  const { hour, minute } = config.digestTime;
  console.log(`[retro-agent] @${me.username} 로 시작합니다. 정리 시각 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${process.env.TZ ?? '시스템 기본'})`);

  const scheduler = setInterval(() => {
    pipeline.maybeRunDigest().catch((error) => console.error('[scheduler] 실패:', error));
  }, SCHEDULER_INTERVAL_MS);

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[retro-agent] ${signal} 수신 — 종료합니다.`);
      stopping = true;
      clearInterval(scheduler);
      // long-polling 이 최대 50초 붙들고 있으므로 즉시 끊어준다.
      process.exit(0);
    });
  }

  let { offset } = await offsetStore.read();
  let backoff = 1000;

  while (!stopping) {
    let updates;
    try {
      updates = await telegram.getUpdates({ offset, timeout: POLL_TIMEOUT_SECONDS });
      backoff = 1000;
    } catch (error) {
      console.error(`[poll] 실패 — ${Math.round(backoff / 1000)}초 뒤 재시도:`, error.message);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      // 같은 업데이트를 두 번 처리하지 않도록 처리 전에 offset 을 확정한다.
      await offsetStore.write({ offset });
      try {
        await handleUpdate(update, { config, telegram, pipeline });
      } catch (error) {
        console.error('[handle] 처리 실패:', error);
      }
    }
  }
}

async function handleUpdate(update, { config, telegram, pipeline }) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;

  // 봇 토큰이 새어나가도 남이 내 회고에 쓸 수는 없어야 한다.
  if (String(chatId) !== config.telegram.chatId) {
    console.warn(`[auth] 허용되지 않은 chat 무시: ${chatId}`);
    return;
  }

  if (update.callback_query) {
    await pipeline.handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  const text = (message?.text ?? message?.caption ?? '').trim();
  if (!text) {
    await telegram.sendMessage(config.telegram.chatId, '텍스트만 받을 수 있습니다.');
    return;
  }

  if (text.startsWith('/') && (await handleCommand(text, { pipeline, config }))) return;

  await pipeline.queue.append({
    id: message.message_id,
    ts: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    text,
    messageId: message.message_id,
  });
  await telegram.react(config.telegram.chatId, message.message_id, '👌');
}

main().catch((error) => {
  console.error('[retro-agent] 치명적 오류:', error);
  process.exit(1);
});
