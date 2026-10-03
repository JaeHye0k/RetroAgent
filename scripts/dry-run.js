/**
 * 텔레그램·노션 없이 정리 품질만 확인한다. 프롬프트 튜닝은 여기서 반복한다.
 *
 *   npm run dry-run                 # 내장 샘플로 실행
 *   npm run dry-run my-notes.txt    # 파일의 각 줄을 조각글로 사용
 *
 * .env 가 필요하다(설정값에 기본값이 없다). npm run 으로 돌리면 --env-file 이 붙는다.
 */
import fs from 'node:fs/promises';
import { doneBlocks, droppedBlocks, learningBlocks } from '../src/blocks.js';
import { Composer } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { DAILY_SECTIONS } from '../src/cycles.js';
import { renderPreview } from '../src/render.js';
import { retroDateOf } from '../src/schedule.js';

/**
 * 가상의 하루. 정리기가 다뤄야 하는 패턴을 골고루 담았다.
 * 프로젝트 그룹핑, 부연이 딸린 항목, 사실과 배움이 한 조각에 섞인 경우,
 * 업무와 무관한 개인 기록, 학습 감상.
 */
const SAMPLE = [
  '장바구니 담기 버튼 눌러도 아무 반응 없던 버그 고침',
  '결제 단계에서 이탈이 많은 것 같아서 각 단계마다 로그를 심으려다가, 컴포넌트 정리랑 같이 하다 보니 결국 배포까지 못 갔다. 단계가 4개나 되는 게 문제인 듯',
  '한 번에 두 가지를 바꾸면 뭐가 원인인지 알 수 없게 된다',
  '물 마시기: 오전 2잔, 오후 3잔. 커피는 1잔으로 줄임',
  'React Query 캐시 무효화를 잘못 이해하고 있었다. staleTime 과 gcTime 을 헷갈렸음',
  '저녁에 집중이 안 돼서 자꾸 딴 탭을 열었다. 타이머를 써봐야 할까',
];

const file = process.argv[2];
const texts = file
  ? (await fs.readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean)
  : SAMPLE;

const base = new Date();
const fragments = texts.map((text, index) => ({
  id: index + 1,
  ts: new Date(base.getTime() - (texts.length - index) * 45 * 60 * 1000).toISOString(),
  text,
  messageId: index + 1,
}));

const config = loadConfig();
const dateString = retroDateOf(base, config.cutoffHour);

console.log(`\n조각 ${fragments.length}개를 ${dateString} 회고로 정리합니다. claude 호출 중…\n`);
const started = Date.now();

const composer = new Composer(config.claude);

const { draft, ok, reason } = await composer.compose({ fragments, dateString });

console.log(`${ok ? '✅ 정리 성공' : `⚠️ ${reason}`} (${((Date.now() - started) / 1000).toFixed(1)}초)\n`);
console.log('── 텔레그램 미리보기 ────────────────────────────');
console.log(renderPreview(draft, { fragmentCount: fragments.length, note: ok ? undefined : reason }));

console.log('\n── 노션에 만들어질 블록 ─────────────────────────');
console.log(
  JSON.stringify(
    {
      [DAILY_SECTIONS.done]: [...doneBlocks(draft.done), ...droppedBlocks(draft.dropped)],
      [DAILY_SECTIONS.learnings]: learningBlocks(draft.learnings),
    },
    null,
    2,
  ),
);
