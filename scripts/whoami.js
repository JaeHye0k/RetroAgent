/**
 * 셋업 확인용. 봇·노션 연결 상태를 한 번에 점검한다.
 *
 *   node --env-file=.env scripts/whoami.js
 *
 * TELEGRAM_CHAT_ID 를 아직 모를 때는 그 줄을 아무 숫자로 채워두고 실행하면
 * 최근 메시지에서 실제 chat id 를 찾아준다.
 */
import { ConfigError, loadConfig } from '../src/config.js';
import { Notion } from '../src/notion.js';
import { retroDateOf } from '../src/schedule.js';
import { Telegram } from '../src/telegram.js';

const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg) => console.log(`  ❌ ${msg}`);

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n설정 오류\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

console.log('\n── 텔레그램 ──────────────────────────');
const telegram = new Telegram({ token: config.telegram.token });
try {
  const me = await telegram.getMe();
  ok(`봇 연결: @${me.username} (${me.first_name})`);
} catch (error) {
  bad(`봇 연결 실패: ${error.message}`);
}

try {
  const updates = await telegram.getUpdates({ timeout: 0 });
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (chat) chats.set(String(chat.id), chat);
  }

  if (!chats.size) {
    console.log('  ℹ️  최근 메시지가 없습니다. 봇에게 아무 메시지나 보낸 뒤 다시 실행해보세요.');
    console.log('      (이미 봇이 돌고 있으면 그쪽이 메시지를 가져가므로 먼저 중지해주세요.)');
  } else {
    for (const [id, chat] of chats) {
      const mark = id === config.telegram.chatId ? '←  .env 의 TELEGRAM_CHAT_ID 와 일치' : '';
      console.log(`  📇 chat id ${id} — ${chat.first_name ?? chat.title ?? chat.type} ${mark}`);
    }
    if (!chats.has(config.telegram.chatId)) {
      bad(`.env 의 TELEGRAM_CHAT_ID(${config.telegram.chatId}) 와 일치하는 chat 이 없습니다. 위 id 로 바꿔주세요.`);
    }
  }
} catch (error) {
  bad(`업데이트 조회 실패: ${error.message}`);
}

console.log('\n── 노션 ──────────────────────────────');
const notion = new Notion({ token: config.notion.token, dbId: config.notion.dbId });
try {
  const database = await notion.retrieveDatabase();
  const title = database.title?.map((t) => t.plain_text).join('') ?? '(제목 없음)';
  ok(`DB 접근: "${title}"`);

  const props = Object.keys(database.properties ?? {});
  for (const required of ['이름', '날짜', '주기']) {
    if (props.includes(required)) ok(`속성 "${required}" 확인`);
    else bad(`속성 "${required}" 가 없습니다. 현재 속성: ${props.join(', ')}`);
  }

  const today = retroDateOf(new Date(), config.cutoffHour);
  const page = await notion.findDailyPage(today);
  console.log(page ? `  📄 ${today} 일간 회고 페이지가 이미 있습니다.` : `  📄 ${today} 일간 회고 페이지는 아직 없습니다 (저장 시 새로 만듭니다).`);
} catch (error) {
  bad(`노션 접근 실패: ${error.message}`);
  console.log('      DB 우상단 ··· → 연결 → integration 을 추가했는지 확인해주세요.');
}

console.log('');
