/**
 * 날짜 귀속과 digest 발송 시점 판단.
 *
 * "회고 날짜(retro date)"는 달력 날짜와 다르다. 새벽 2시에 보낸 조각은
 * 사람 감각으로는 어제 하루의 일부이므로 전날 회고에 귀속시킨다.
 * 그 경계가 cutoffHour 이다.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → 로컬 시간대 기준 'YYYY-MM-DD' */
export function toDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 'YYYY-MM-DD' + 시:분 → 로컬 시간대 Date */
export function atLocalTime(dateString, { hour, minute }) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}

/**
 * 이 시각에 쓴 글은 어느 날짜의 회고에 들어가야 하는가.
 * cutoffHour 이전이면 전날로 귀속한다.
 */
export function retroDateOf(date, cutoffHour) {
  const shifted = new Date(date.getTime());
  if (shifted.getHours() < cutoffHour) {
    shifted.setDate(shifted.getDate() - 1);
  }
  return toDateString(shifted);
}

/** '2026-07-26' → '2026.07.26 일간 회고' */
export function pageTitleFor(dateString) {
  return `${dateString.replaceAll('-', '.')} 일간 회고`;
}

/** '2026-07-26' → '7월 26일 (일)' — 사람이 읽는 라벨 */
export function humanDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

/**
 * 조각을 각자의 ts 기준 회고 날짜로 묶는다. 오래된 날짜가 먼저 온다.
 *
 * 날짜를 "지금"이 아니라 조각이 쓰인 시각에서 뽑는 것이 핵심이다. 맥을 월요일
 * 밤에 덮고 화요일 아침에 열면, 큐에 남은 월요일 조각은 월요일 회고로 가야 한다.
 *
 * ts 가 깨진 조각은 fallbackDate 로 몰아넣는다 — 버리지는 않는다.
 */
export function groupByRetroDate(fragments, cutoffHour, fallbackDate) {
  const groups = new Map();

  for (const fragment of fragments) {
    const written = new Date(fragment.ts);
    const date = Number.isNaN(written.getTime()) ? fallbackDate : retroDateOf(written, cutoffHour);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(fragment);
  }

  return [...groups.entries()]
    .map(([retroDate, items]) => ({ retroDate, fragments: items }))
    .sort((a, b) => a.retroDate.localeCompare(b.retroDate));
}

/**
 * 자동 발송할 때가 된 그룹들. 오래된 날짜부터.
 *
 * 임계 시각은 "그 회고 날짜 당일의 DIGEST_TIME" 이다. 이렇게 두면 23:00 에
 * 잠들어 있다가 새벽 1시에, 혹은 이틀 뒤에 깨어나도 밀린 날짜가 순서대로 나온다.
 */
export function dueGroups({ now, groups, digestTime, doneDates = [] }) {
  const done = new Set(doneDates);
  return groups.filter(
    (group) =>
      !done.has(group.retroDate) && now.getTime() >= atLocalTime(group.retroDate, digestTime).getTime(),
  );
}
