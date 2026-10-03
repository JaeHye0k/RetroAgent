/**
 * 텔레그램·노션 없이 주기 회고 품질만 확인한다. KLPT 프롬프트 튜닝은 여기서 반복한다.
 *
 *   npm run dry-run-period           # 내장 샘플(한 주치)로 실행
 *   npm run dry-run-period monthly   # 다른 주기로 실행
 *
 * .env 가 필요하다(설정값에 기본값이 없다). npm run 으로 돌리면 --env-file 이 붙는다.
 */
import { bulletBlocks, tryBlocks, tryReviewBlocks } from '../src/blocks.js';
import { Composer } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { CYCLES, PERIOD_SECTIONS, rangeOf, titleFor } from '../src/cycles.js';
import { renderPeriodPreview } from '../src/render.js';

/**
 * 가상의 한 주. 주기 회고가 다뤄야 하는 것들을 골고루 담았다 —
 * 여러 날 반복되는 주제, 하루짜리 사건, 지난 Try 가 지켜진 흔적과 안 지켜진 흔적.
 */
const SAMPLE = [
  {
    title: '2026.09.28 일간 회고',
    text: '## 오늘 한 일\n**결제 개선**\n- 결제 단계마다 로그를 심었다\n- 4단계 중 2단계까지 배포\n**물 마시기**\n- 5잔\n## 한 줄 배움 / 감정\n- 로그를 먼저 심으니 추측할 일이 줄었다',
  },
  {
    title: '2026.09.29 일간 회고',
    text: '## 오늘 한 일\n**결제 개선**\n- 나머지 2단계 로그 배포 완료\n**물 마시기**\n- 5잔\n## 한 줄 배움 / 감정\n- 저녁에 집중이 흐트러져서 딴 탭을 계속 열었다',
  },
  {
    title: '2026.09.30 일간 회고',
    text: '## 오늘 한 일\n- 로그를 보니 3단계에서 이탈이 가장 많았다\n**물 마시기**\n- 4잔\n## 한 줄 배움 / 감정\n- 데이터를 보기 전 추측이 틀렸다. 2단계일 줄 알았다',
  },
  {
    title: '2026.10.01 일간 회고',
    text: '## 오늘 한 일\n- 3단계 폼 필드를 6개에서 3개로 줄이는 작업 시작\n## 한 줄 배움 / 감정\n- 저녁 집중력 문제가 이번 주 내내 반복된다',
  },
  {
    title: '2026.10.02 일간 회고',
    text: '## 오늘 한 일\n- 폼 축소 배포\n- React Query 캐시 무효화를 잘못 이해하고 있었다. staleTime 과 gcTime 을 헷갈렸음\n## 한 줄 배움 / 감정\n- 한 번에 두 가지를 바꾸면 뭐가 원인인지 알 수 없게 된다',
  },
  {
    title: '2026.10.03 일간 회고',
    text: '## 오늘 한 일\n- 이탈률이 조금 줄었다. 아직 단정하기는 이름\n**물 마시기**\n- 2잔. 주말이라 흐트러짐\n## 한 줄 배움 / 감정\n- 주말에 습관이 무너진다',
  },
  {
    title: '2026.10.04 일간 회고',
    text: '## 오늘 한 일\n- 쉬었다\n## 한 줄 배움 / 감정\n- 저녁 집중 문제는 타이머를 써봐야 할 것 같다',
  },
];

const PREVIOUS_TRY = [
  '- [x] 결제 단계마다 로그 심기',
  '- [ ] 저녁에 타이머 써보기',
  '- [ ] 매일 물 5잔 마시기',
].join('\n');

const cycle = process.argv[2] ?? 'weekly';
if (!CYCLES[cycle] || CYCLES[cycle].rank === 0) {
  console.error(`주기를 알 수 없습니다: ${cycle}\n쓸 수 있는 값: weekly, monthly, quarterly, half, yearly`);
  process.exit(1);
}

const config = loadConfig();
const range = rangeOf(cycle, '2026-10-04');
const title = titleFor(cycle, range);

console.log(`\n회고 ${SAMPLE.length}개를 "${title}" 로 간추립니다. claude 호출 중…\n`);
const started = Date.now();

const composer = new Composer(config.claude);
const { draft, ok, reason } = await composer.composePeriod({
  title,
  cycleName: CYCLES[cycle].name,
  range,
  sources: SAMPLE,
  previousTry: PREVIOUS_TRY,
});

if (!ok) {
  // 주기 회고에는 폴백이 없다. 실패하면 빈 페이지를 만들지 않고 여기서 끝난다.
  console.error(`❌ ${reason} (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  process.exit(1);
}

console.log(`✅ 정리 성공 (${((Date.now() - started) / 1000).toFixed(1)}초)\n`);
console.log('── 텔레그램 미리보기 ────────────────────────────');
console.log(renderPeriodPreview(draft, { title, sourceCount: SAMPLE.length }));

console.log('\n── 노션에 만들어질 블록 ─────────────────────────');
console.log(
  JSON.stringify(
    {
      [PERIOD_SECTIONS.tryReview]: tryReviewBlocks(draft.tryReview),
      [PERIOD_SECTIONS.keep]: bulletBlocks(draft.keep),
      [PERIOD_SECTIONS.problem]: bulletBlocks(draft.problem),
      [PERIOD_SECTIONS.learned]: bulletBlocks(draft.learned),
      [PERIOD_SECTIONS.try]: tryBlocks(draft.try),
    },
    null,
    2,
  ),
);
