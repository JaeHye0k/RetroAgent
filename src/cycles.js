/**
 * 회고 주기의 단일 출처.
 *
 * 일간부터 연간까지 여섯 주기를 한 레지스트리에 둔다. 날짜 범위·제목·노션
 * `주기` 속성값·템플릿 파일 이름이 전부 여기서 나온다.
 *
 * 일간을 함께 두는 이유: 일간을 rank 0 짜리 주기로 보면 coveragePlan 이
 * 일간만 특별 취급할 필요가 없어진다. 자연스럽게 가장 잘게 쪼갠 fallback 이 된다.
 *
 * 전부 순수 함수다. 네트워크도 파일도 건드리지 않는다.
 */
import { atLocalTime, pageTitleFor, retroDateOf, toDateString } from './schedule.js';

/** 주기 회고가 공유하는 KLPT 섹션 — 스키마 키 → 템플릿의 섹션 제목 */
export const PERIOD_SECTIONS = {
  tryReview: '지난 주기 Try 점검',
  keep: 'Keep',
  problem: 'Problem',
  learned: 'Learned',
  try: 'Try',
};

/**
 * rank 는 주기의 크기다. 겹치는 날에 어느 주기가 이기는지, 그리고
 * 재료를 고를 때 어느 페이지를 먼저 집는지를 모두 이 숫자가 정한다.
 */
export const CYCLES = {
  daily: {
    name: '일간',
    rank: 0,
    template: 'daily.md',
    sections: { done: '오늘 한 일', learnings: '한 줄 배움 / 감정' },
  },
  weekly: { name: '주간', rank: 1, template: 'period.md', sections: PERIOD_SECTIONS },
  monthly: { name: '월간', rank: 2, template: 'period.md', sections: PERIOD_SECTIONS },
  quarterly: { name: '분기', rank: 3, template: 'period.md', sections: PERIOD_SECTIONS },
  half: { name: '반기', rank: 4, template: 'period.md', sections: PERIOD_SECTIONS },
  yearly: { name: '연간', rank: 5, template: 'period.md', sections: PERIOD_SECTIONS },
};

export const DAILY = 'daily';

/** 일간 회고의 섹션 제목. 미리보기와 저장 단계가 함께 본다. */
export const DAILY_SECTIONS = CYCLES.daily.sections;

/**
 * 자동 발송 대상 주기 — 큰 것부터.
 *
 * 일간은 여기 없다. 일간은 매일 끝나므로 경계 판정에 끼면 매일 주기 회고가
 * 나가버린다. 일간을 모는 것은 조각글 큐이지 달력이 아니다.
 */
export const PERIODIC_CYCLES = Object.keys(CYCLES)
  .filter((cycle) => CYCLES[cycle].rank > 0)
  .sort((a, b) => CYCLES[b].rank - CYCLES[a].rank);

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → 로컬 자정 Date */
function parseDate(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'YYYY-MM-DD' 에 일수를 더한다. 월·연 경계는 Date 가 알아서 넘긴다. */
export function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setDate(date.getDate() + days);
  return toDateString(date);
}

/** 그 달의 마지막 날짜(1~31). month 는 1~12. */
export function lastDayOfMonth(year, month) {
  // 다음 달 0일 = 이번 달 말일. 윤년도 여기서 자동으로 맞는다.
  return new Date(year, month, 0).getDate();
}

/** 시작~끝(양 끝 포함)의 날짜 문자열 목록 */
export function daysBetween(start, end) {
  const days = [];
  for (let date = start; date <= end; date = addDays(date, 1)) days.push(date);
  return days;
}

/** 노션에서 읽어온 '주기' 속성값 → 레지스트리 키. 모르는 값이면 null. */
export function cycleByName(name) {
  return Object.keys(CYCLES).find((cycle) => CYCLES[cycle].name === name) ?? null;
}

/** 이 주기의 회고가 end 에 끝난다면, 그 기간은 언제 시작했는가. */
export function rangeOf(cycle, end) {
  const [year, month] = String(end).split('-').map(Number);

  switch (cycle) {
    case 'daily':
      return { start: end, end };
    case 'weekly':
      // 월요일~일요일. end 는 일요일이다.
      return { start: addDays(end, -6), end };
    case 'monthly':
      return { start: `${year}-${pad2(month)}-01`, end };
    case 'quarterly':
      return { start: `${year}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`, end };
    case 'half':
      return { start: `${year}-${month <= 6 ? '01' : '07'}-01`, end };
    case 'yearly':
      return { start: `${year}-01-01`, end };
    default:
      throw new Error(`알 수 없는 주기: ${cycle}`);
  }
}

/** 사람이 읽는 페이지 제목. 노션 '이름' 속성에 그대로 들어간다. */
export function titleFor(cycle, range) {
  const [year, month] = range.end.split('-').map(Number);

  switch (cycle) {
    case 'daily':
      return pageTitleFor(range.end);
    case 'weekly': {
      const [sy, sm, sd] = range.start.split('-').map(Number);
      const [ey, em, ed] = range.end.split('-').map(Number);
      // 주는 연을 넘을 수 있다. 그때만 뒤쪽에도 연도를 적는다.
      const tail = sy === ey ? `${pad2(em)}.${pad2(ed)}` : `${ey}.${pad2(em)}.${pad2(ed)}`;
      return `${sy}.${pad2(sm)}.${pad2(sd)} – ${tail} 주간 회고`;
    }
    case 'monthly':
      return `${year}.${pad2(month)} 월간 회고`;
    case 'quarterly':
      return `${year} ${Math.floor((month - 1) / 3) + 1}분기 회고`;
    case 'half':
      return `${year} ${month <= 6 ? '상반기' : '하반기'} 회고`;
    case 'yearly':
      return `${year} 연간 회고`;
    default:
      throw new Error(`알 수 없는 주기: ${cycle}`);
  }
}

/** 이미 보낸 주기를 기억하기 위한 식별자 */
export function cycleKey(cycle, end) {
  return `${cycle}:${end}`;
}

/** rangeOf·titleFor·cycleKey 를 한 덩어리로 */
function describe(cycle, end) {
  const range = rangeOf(cycle, end);
  return { cycle, ...range, title: titleFor(cycle, range), key: cycleKey(cycle, end) };
}

/**
 * 이 날짜에 끝나는 주기 중 **가장 큰 것 하나**. 없으면 null.
 *
 * 12월 31일은 월말·분기말·반기말·연말이 모두 겹치지만 연간 하나만 돌려준다.
 * 하루에 회고를 네 번 쓰게 만들 수는 없다.
 */
export function periodEndingOn(dateString) {
  const date = parseDate(dateString);
  const [year, month, day] = dateString.split('-').map(Number);
  const monthDay = `${pad2(month)}-${pad2(day)}`;

  for (const cycle of PERIODIC_CYCLES) {
    const ends =
      (cycle === 'yearly' && monthDay === '12-31') ||
      (cycle === 'half' && (monthDay === '06-30' || monthDay === '12-31')) ||
      (cycle === 'quarterly' && ['03-31', '06-30', '09-30', '12-31'].includes(monthDay)) ||
      (cycle === 'monthly' && day === lastDayOfMonth(year, month)) ||
      (cycle === 'weekly' && date.getDay() === 0);

    if (ends) return describe(cycle, dateString);
  }
  return null;
}

/**
 * 지금 정리할 때가 된 주기들. 오래된 것부터.
 *
 * 과거를 lookbackDays 만큼 되짚는 이유는 일간의 dueGroups 와 같다 —
 * 맥북을 덮고 자도, 며칠 꺼져 있어도 밀린 주기가 순서대로 나와야 한다.
 */
export function duePeriods({ now, periodicTime, donePeriods = [], cutoffHour, lookbackDays = 45 }) {
  const today = retroDateOf(now, cutoffHour);
  const done = new Set(donePeriods);
  const due = [];

  for (let back = lookbackDays; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    const period = periodEndingOn(date);
    if (!period || done.has(period.key)) continue;
    // 그 주기가 끝난 날의 발송 시각이 지나야 한다.
    if (now.getTime() < atLocalTime(date, periodicTime).getTime()) continue;
    due.push(period);
  }

  return due;
}

/**
 * 주기 회고의 재료로 쓸 페이지를 고른다.
 *
 * 굵은 것부터 덮어간다. 2026 연간이라면 상반기 페이지 하나가 1~6월을 통째로
 * 대신하고, 남은 구간만 분기·월간·주간·일간으로 메운다. 365개 일간을 통째로
 * 넣는 것보다 양이 줄고 요약이 뭉개지지 않는다.
 *
 * '가장 큰 주기 하나만' 규칙 때문에 계층에는 구멍이 생긴다(12/31 엔 연간만
 * 만들어지므로 12월 월간·4분기·하반기 페이지가 없다). 이 함수가 그 구멍을
 * 더 잘게 쪼갠 페이지로 메운다.
 *
 * @param pages 노션에서 읽어온 `{ id, date, cycle, ... }` 목록
 * @returns 날짜순으로 정렬된, 서로 겹치지 않는 페이지들
 */
export function coveragePlan({ cycle, range, pages }) {
  const targetRank = CYCLES[cycle]?.rank;
  if (targetRank === undefined) throw new Error(`알 수 없는 주기: ${cycle}`);

  const candidates = pages
    .filter((page) => CYCLES[page.cycle] && CYCLES[page.cycle].rank < targetRank)
    .map((page) => ({ page, span: rangeOf(page.cycle, page.date) }))
    // 기간 밖으로 삐져나오는 페이지는 쓰지 않는다. 남의 기간 내용이 섞인다.
    .filter(({ span }) => span.start >= range.start && span.end <= range.end)
    .sort(
      (a, b) =>
        CYCLES[b.page.cycle].rank - CYCLES[a.page.cycle].rank ||
        a.page.date.localeCompare(b.page.date),
    );

  const covered = new Set();
  const chosen = [];

  for (const { page, span } of candidates) {
    const days = daysBetween(span.start, span.end);
    // 이미 더 굵은 페이지가 덮은 구간이면 건너뛴다. 같은 날을 두 번 넣지 않는다.
    if (days.some((day) => covered.has(day))) continue;
    for (const day of days) covered.add(day);
    chosen.push(page);
  }

  return chosen.sort((a, b) => a.date.localeCompare(b.date));
}
