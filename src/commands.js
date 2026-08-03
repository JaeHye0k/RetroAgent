import { humanDate } from './schedule.js';

const HELP = [
  '🧵 <b>회고 에이전트</b>',
  '',
  '생각날 때마다 그냥 보내세요. 텍스트든 🎙️ 음성 메모든 큐에 쌓아뒀다가 정해진 시각에 노션 일간 회고로 정리해 미리보기를 보냅니다.',
  '',
  '<b>/now</b> — 지금까지 쌓인 조각을 바로 정리',
  '<b>/queue</b> — 큐에 쌓인 조각 보기',
  '<b>/undo</b> — 마지막 저장 되돌리기',
  '<b>/help</b> — 이 도움말',
].join('\n');

/**
 * 명령이면 처리하고 true, 아니면 false 를 돌려준다.
 * false 면 호출한 쪽에서 일반 조각글로 큐에 넣는다.
 */
export async function handleCommand(text, { pipeline, config }) {
  const command = /^\/([a-zA-Z_]+)/.exec(text.trim())?.[1]?.toLowerCase();
  if (!command) return false;

  switch (command) {
    case 'now':
      await pipeline.runDigest();
      return true;

    case 'queue':
      await pipeline.showQueue();
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
