// Date 를 만들기 전에 시간대를 고정한다. 머신 설정과 무관하게 같은 결과가 나와야 한다.
process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  dueGroups,
  groupByRetroDate,
  humanDate,
  pageTitleFor,
  retroDateOf,
  toDateString,
} from '../src/schedule.js';

const CUTOFF = 4;
const DIGEST = { hour: 23, minute: 0 };

describe('retroDateOf — 새벽에 쓴 글은 전날 회고로', () => {
  test('cutoff 이후는 그날로 귀속', () => {
    assert.equal(retroDateOf(new Date(2026, 6, 27, 4, 0), CUTOFF), '2026-07-27');
    assert.equal(retroDateOf(new Date(2026, 6, 27, 14, 30), CUTOFF), '2026-07-27');
    assert.equal(retroDateOf(new Date(2026, 6, 27, 23, 59), CUTOFF), '2026-07-27');
  });

  test('cutoff 이전은 전날로 귀속', () => {
    assert.equal(retroDateOf(new Date(2026, 6, 27, 0, 1), CUTOFF), '2026-07-26');
    assert.equal(retroDateOf(new Date(2026, 6, 27, 3, 59), CUTOFF), '2026-07-26');
  });

  test('월·연 경계를 넘어간다', () => {
    assert.equal(retroDateOf(new Date(2026, 6, 1, 2, 0), CUTOFF), '2026-06-30');
    assert.equal(retroDateOf(new Date(2026, 0, 1, 1, 0), CUTOFF), '2025-12-31');
    assert.equal(retroDateOf(new Date(2026, 2, 1, 2, 0), CUTOFF), '2026-02-28');
  });

  test('cutoff 0 이면 달력 날짜와 같다', () => {
    assert.equal(retroDateOf(new Date(2026, 6, 27, 0, 30), 0), '2026-07-27');
  });
});

describe('날짜 포맷', () => {
  test('toDateString 은 로컬 기준 YYYY-MM-DD', () => {
    assert.equal(toDateString(new Date(2026, 6, 5, 23, 59)), '2026-07-05');
  });

  test('pageTitleFor 는 기존 페이지 제목 관례를 따른다', () => {
    assert.equal(pageTitleFor('2026-07-26'), '2026.07.26 일간 회고');
  });

  test('humanDate 는 요일을 붙인다', () => {
    assert.equal(humanDate('2026-07-26'), '7월 26일 (일)');
  });
});

const at = (iso, id = iso) => ({ id, ts: iso, text: `조각 ${id}` });

describe('groupByRetroDate — 조각이 쓰인 시각으로 묶는다', () => {
  test('빈 입력은 빈 배열', () => {
    assert.deepEqual(groupByRetroDate([], CUTOFF, '2026-07-27'), []);
  });

  test('같은 날 조각은 한 그룹', () => {
    const groups = groupByRetroDate(
      [at('2026-07-27T10:00:00+09:00'), at('2026-07-27T21:30:00+09:00')],
      CUTOFF,
      '2026-07-27',
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].retroDate, '2026-07-27');
    assert.equal(groups[0].fragments.length, 2);
  });

  test('새벽 조각은 전날 그룹에 붙는다', () => {
    const groups = groupByRetroDate(
      [at('2026-07-27T21:00:00+09:00'), at('2026-07-28T02:00:00+09:00')],
      CUTOFF,
      '2026-07-28',
    );
    assert.equal(groups.length, 1, '둘 다 07-27 몫이다');
    assert.equal(groups[0].retroDate, '2026-07-27');
  });

  test('여러 날짜는 오래된 순으로 정렬된다', () => {
    const groups = groupByRetroDate(
      [
        at('2026-07-29T10:00:00+09:00', 'wed'),
        at('2026-07-27T10:00:00+09:00', 'mon'),
        at('2026-07-28T10:00:00+09:00', 'tue'),
      ],
      CUTOFF,
      '2026-07-29',
    );
    assert.deepEqual(groups.map((g) => g.retroDate), ['2026-07-27', '2026-07-28', '2026-07-29']);
  });

  test('ts 가 깨진 조각은 버리지 않고 fallback 날짜로 몰아넣는다', () => {
    const groups = groupByRetroDate([at('말이 안 되는 값', 'bad')], CUTOFF, '2026-07-29');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].retroDate, '2026-07-29');
    assert.equal(groups[0].fragments[0].id, 'bad');
  });

  test('월 경계를 넘는 새벽 조각도 전날로', () => {
    const groups = groupByRetroDate([at('2026-08-01T01:00:00+09:00')], CUTOFF, '2026-08-01');
    assert.equal(groups[0].retroDate, '2026-07-31');
  });
});

describe('dueGroups — 임계 시각이 지난 날짜만', () => {
  const monday = { retroDate: '2026-07-27', fragments: [at('2026-07-27T10:00:00+09:00')] };
  const tuesday = { retroDate: '2026-07-28', fragments: [at('2026-07-28T10:00:00+09:00')] };
  const groups = [monday, tuesday];

  test('정리 시각 전에는 아무것도 나오지 않는다', () => {
    const due = dueGroups({ now: new Date(2026, 6, 27, 22, 59), groups: [monday], digestTime: DIGEST });
    assert.equal(due.length, 0);
  });

  test('정리 시각이 되면 그날 몫이 나온다', () => {
    const due = dueGroups({ now: new Date(2026, 6, 27, 23, 0), groups: [monday], digestTime: DIGEST });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-27']);
  });

  test('맥이 자다가 새벽에 깨어나면 그 시점에 나온다', () => {
    const due = dueGroups({ now: new Date(2026, 6, 28, 1, 30), groups: [monday], digestTime: DIGEST });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-27']);
  });

  test('월요일 밤에 덮고 화요일 아침에 열어도 월요일 몫이 나온다', () => {
    // 이게 ts 기반으로 바꾼 이유다. "지금"으로 날짜를 계산하면 이 건이 사라진다.
    const due = dueGroups({ now: new Date(2026, 6, 28, 9, 0), groups: [monday], digestTime: DIGEST });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-27']);
  });

  test('아직 임계 시각이 안 된 오늘 몫은 섞여 나오지 않는다', () => {
    const due = dueGroups({ now: new Date(2026, 6, 28, 9, 0), groups, digestTime: DIGEST });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-27'], '화요일은 화요일 23:00 이후에');
  });

  test('며칠 밀리면 전부 나오되 오래된 순서를 지킨다', () => {
    const due = dueGroups({ now: new Date(2026, 6, 30, 9, 0), groups, digestTime: DIGEST });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-27', '2026-07-28']);
  });

  test('이미 처리한 날짜는 건너뛴다', () => {
    const due = dueGroups({
      now: new Date(2026, 6, 30, 9, 0),
      groups,
      digestTime: DIGEST,
      doneDates: ['2026-07-27'],
    });
    assert.deepEqual(due.map((g) => g.retroDate), ['2026-07-28']);
  });
});
