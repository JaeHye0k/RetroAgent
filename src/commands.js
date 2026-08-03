import { humanDate } from './schedule.js';

const HELP = [
  '🧵 <b>회고 에이전트</b>',
  '',
  '생각날 때마다 그냥 보내세요. 텍스트든 🎙️ 음성 메모든 큐에 쌓아뒀다가 정해진 시각에 노션 일간 회고로 정리해 미리보기를 보냅니다.',
  '',
  '<b>/now</b> — 지금까지 쌓인 조각을 바로 정리',
  '<b>/queue</b> — 큐에 쌓인 조각 보기',
  '<b>/drop 2</b> — 큐에서 2번 조각 빼기',
  '<b>/clear</b> — 큐 전체 비우기 (확인 후)',
  '<b>/undo</b> — 마지막 저장 되돌리기',
  '<b>/help</b> — 이 도움말',
].join('\n');

const DROP_USAGE = [
  '🗑 <b>/drop</b> — /queue 에 보이는 번호로 조각을 뺍니다.',
  '',
  '<code>/drop 2</code> — 2번 하나',
  '<code>/drop 2 5</code> — 2번과 5번',
  '<code>/drop 2-4</code> — 2번부터 4번까지',
  '',
  '큐 전체를 비우려면 <b>/clear</b>.',
].join('\n');

/** 한 번에 지정할 수 있는 조각 수 상한 — 이보다 넓으면 오타로 본다. */
const MAX_SELECTION = 500;

/**
 * '2', '2 5', '2-4', '2,5-7' → [2, 5, 6, 7] (오름차순, 중복 제거).
 * 하나라도 읽을 수 없으면 null 을 돌려준다 — 절반만 지우는 것이 가장 나쁘다.
 */
export function parseSelection(arg) {
  // '2 - 4' 처럼 띄어 쓴 범위도 한 덩어리로 본다.
  const tokens = String(arg ?? '')
    .replace(/\s*([-~])\s*/g, '$1')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  const numbers = new Set();
  for (const token of tokens) {
    const range = /^(\d+)[-~](\d+)$/.exec(token);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
      if (!from || to - from >= MAX_SELECTION) return null;
      for (let n = from; n <= to; n += 1) numbers.add(n);
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (!n) return null;
    numbers.add(n);
  }

  if (numbers.size > MAX_SELECTION) return null;
  return [...numbers].sort((a, b) => a - b);
}

/**
 * 명령이면 처리하고 true, 아니면 false 를 돌려준다.
 * false 면 호출한 쪽에서 일반 조각글로 큐에 넣는다.
 */
export async function handleCommand(text, { pipeline, config }) {
  // 그룹에서는 /drop@내봇이름 3 형태로 온다. 봇 이름은 떼고 나머지를 인자로 넘긴다.
  const match = /^\/([a-zA-Z_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text.trim());
  const command = match?.[1]?.toLowerCase();
  if (!command) return false;
  const args = match[2].trim();

  switch (command) {
    case 'now':
      await pipeline.runDigest();
      return true;

    case 'queue':
      await pipeline.showQueue();
      return true;

    case 'drop':
    case 'rm': {
      const numbers = parseSelection(args);
      if (!numbers) {
        await pipeline.say(DROP_USAGE);
        return true;
      }
      await pipeline.dropFragments(numbers);
      return true;
    }

    case 'clear':
      await pipeline.confirmClear();
      return true;

    case 'undo':
      await pipeline.undo();
      return true;

    case 'start':
    case 'help':
      await pipeline.say(HELP);
      return true;

    case 'status': {
      const [groups, pending] = await Promise.all([pipeline.queueGroups(), pipeline.pending.read()]);
      const { hour, minute } = config.digestTime;
      const total = groups.reduce((sum, group) => sum + group.fragments.length, 0);
      const today = pipeline.currentRetroDate();

      const lines = [
        `🕘 정리 시각: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        `📅 오늘의 회고 날짜: ${today}`,
        `📥 큐: ${total}개`,
      ];
      for (const group of groups) {
        const mark = group.retroDate === today ? '오늘' : '밀림';
        lines.push(`   · ${humanDate(group.retroDate)} — ${group.fragments.length}개 (${mark})`);
      }
      const backlog = groups.filter((group) => group.retroDate !== today).length;
      if (backlog) lines.push('', `⚠️ 밀린 날짜 ${backlog}일. /now 를 누르면 가장 오래된 날짜부터 정리합니다.`);
      lines.push('', pending ? '⏳ 승인 대기 중인 정리가 있습니다.' : '✅ 대기 중인 정리 없음');

      await pipeline.say(lines.join('\n'));
      return true;
    }

    default:
      await pipeline.say(`알 수 없는 명령입니다: <code>/${command}</code>\n\n${HELP}`);
      return true;
  }
}
