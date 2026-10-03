process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  CYCLES,
  addDays,
  coveragePlan,
  cycleByName,
  cycleKey,
  daysBetween,
  duePeriods,
  lastDayOfMonth,
  PERIODIC_CYCLES,
  periodEndingOn,
  rangeOf,
  titleFor,
} from '../src/cycles.js';

describe('레지스트리', () => {
  test('일간은 rank 0, 연간이 가장 크다', () => {
    assert.equal(CYCLES.daily.rank, 0);
    assert.equal(CYCLES.yearly.rank, 5);
  });

  test('PERIODIC_CYCLES 에 일간은 없다', () => {
    assert.ok(!PERIODIC_CYCLES.includes('daily'));
    assert.equal(PERIODIC_CYCLES.length, 5);
  });

  test('PERIODIC_CYCLES 는 큰 주기부터다 — 겹치는 날의 우선순위가 여기서 나온다', () => {
    assert.deepEqual(PERIODIC_CYCLES, ['yearly', 'half', 'quarterly', 'monthly', 'weekly']);
  });

  test('노션 주기 이름으로 되찾을 수 있다', () => {
    assert.equal(cycleByName('일간'), 'daily');
    assert.equal(cycleByName('분기'), 'quarterly');
    assert.equal(cycleByName('없는주기'), null);
  });
});

describe('날짜 도우미', () => {
  test('월·연 경계를 넘는다', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });

  test('말일 — 윤년 2월', () => {
    assert.equal(lastDayOfMonth(2026, 2), 28);
    assert.equal(lastDayOfMonth(2028, 2), 29, '2028 은 윤년');
    assert.equal(lastDayOfMonth(2000, 2), 29, '400 으로 나뉘면 윤년');
    assert.equal(lastDayOfMonth(1900, 2), 28, '100 으로 나뉘면 평년');
    assert.equal(lastDayOfMonth(2026, 4), 30);
  });

  test('양 끝을 포함한 날짜 목록', () => {
    assert.deepEqual(daysBetween('2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.deepEqual(daysBetween('2026-10-01', '2026-10-01'), ['2026-10-01']);
  });
});

describe('rangeOf', () => {
  test('일간은 하루', () => {
    assert.deepEqual(rangeOf('daily', '2026-10-03'), { start: '2026-10-03', end: '2026-10-03' });
  });

  test('주간은 월요일부터 일요일까지', () => {
    // 2026-10-04 는 일요일
    assert.deepEqual(rangeOf('weekly', '2026-10-04'), { start: '2026-09-28', end: '2026-10-04' });
  });

  test('월간은 1일부터', () => {
    assert.deepEqual(rangeOf('monthly', '2026-10-31'), { start: '2026-10-01', end: '2026-10-31' });
  });

  test('분기는 그 분기 첫날부터', () => {
    assert.deepEqual(rangeOf('quarterly', '2026-03-31'), { start: '2026-01-01', end: '2026-03-31' });
    assert.deepEqual(rangeOf('quarterly', '2026-09-30'), { start: '2026-07-01', end: '2026-09-30' });
    assert.deepEqual(rangeOf('quarterly', '2026-12-31'), { start: '2026-10-01', end: '2026-12-31' });
  });

  test('반기는 1월 또는 7월부터', () => {
    assert.deepEqual(rangeOf('half', '2026-06-30'), { start: '2026-01-01', end: '2026-06-30' });
    assert.deepEqual(rangeOf('half', '2026-12-31'), { start: '2026-07-01', end: '2026-12-31' });
  });

  test('연간은 1월 1일부터', () => {
    assert.deepEqual(rangeOf('yearly', '2026-12-31'), { start: '2026-01-01', end: '2026-12-31' });
  });

  test('모르는 주기는 에러', () => {
    assert.throws(() => rangeOf('decade', '2026-12-31'), /알 수 없는 주기/);
  });
});

describe('titleFor', () => {
  test('일간은 기존 제목 형식 그대로', () => {
    assert.equal(titleFor('daily', rangeOf('daily', '2026-10-03')), '2026.10.03 일간 회고');
  });

  test('주간은 기간을 보여준다', () => {
    assert.equal(titleFor('weekly', rangeOf('weekly', '2026-10-04')), '2026.09.28 – 10.04 주간 회고');
  });

  test('연을 넘는 주는 뒤쪽에도 연도를 적는다', () => {
    // 2027-01-03 은 일요일, 그 주는 2026-12-28 에 시작한다.
    assert.equal(
      titleFor('weekly', rangeOf('weekly', '2027-01-03')),
      '2026.12.28 – 2027.01.03 주간 회고',
    );
  });

  test('월간·분기·반기·연간', () => {
    assert.equal(titleFor('monthly', rangeOf('monthly', '2026-10-31')), '2026.10 월간 회고');
    assert.equal(titleFor('quarterly', rangeOf('quarterly', '2026-09-30')), '2026 3분기 회고');
    assert.equal(titleFor('half', rangeOf('half', '2026-06-30')), '2026 상반기 회고');
    assert.equal(titleFor('half', rangeOf('half', '2026-12-31')), '2026 하반기 회고');
    assert.equal(titleFor('yearly', rangeOf('yearly', '2026-12-31')), '2026 연간 회고');
  });
});

describe('periodEndingOn — 겹치는 날은 가장 큰 주기 하나만', () => {
  const cycleOn = (date) => periodEndingOn(date)?.cycle ?? null;

  test('12월 31일은 연간 하나만 — 월말·분기말·반기말이 모두 겹쳐도', () => {
    assert.equal(cycleOn('2026-12-31'), 'yearly');
  });

  test('6월 30일은 반기 — 월말·분기말을 이긴다', () => {
    assert.equal(cycleOn('2026-06-30'), 'half');
  });

  test('3월·9월 말일은 분기', () => {
    assert.equal(cycleOn('2026-03-31'), 'quarterly');
    assert.equal(cycleOn('2026-09-30'), 'quarterly');
  });

  test('그 밖의 말일은 월간', () => {
    assert.equal(cycleOn('2026-10-31'), 'monthly');
    assert.equal(cycleOn('2026-04-30'), 'monthly');
    assert.equal(cycleOn('2026-02-28'), 'monthly', '평년 2월 말일');
    assert.equal(cycleOn('2028-02-29'), 'monthly', '윤년 2월 말일');
  });

  test('평범한 일요일은 주간', () => {
    assert.equal(cycleOn('2026-10-04'), 'weekly');
    assert.equal(cycleOn('2026-10-11'), 'weekly');
  });

  test('월말이자 일요일이면 월간이 이긴다', () => {
    // 2026-05-31 은 일요일이면서 5월 말일
    assert.equal(new Date(2026, 4, 31).getDay(), 0, '전제: 일요일이어야 한다');
    assert.equal(cycleOn('2026-05-31'), 'monthly');
  });

  test('아무 주기도 끝나지 않는 날은 null', () => {
    assert.equal(periodEndingOn('2026-10-03'), null, '토요일, 말일 아님');
    assert.equal(periodEndingOn('2026-02-27'), null);
  });

  test('일간은 절대 나오지 않는다 — 매일 나가버리면 안 된다', () => {
    for (let date = '2026-01-01'; date <= '2026-12-31'; date = addDays(date, 1)) {
      assert.notEqual(periodEndingOn(date)?.cycle, 'daily', `${date} 에서 일간이 나왔다`);
    }
  });

  test('범위·제목·식별자를 함께 준다', () => {
    const period = periodEndingOn('2026-12-31');
    assert.deepEqual(period, {
      cycle: 'yearly',
      start: '2026-01-01',
      end: '2026-12-31',
      title: '2026 연간 회고',
      key: cycleKey('yearly', '2026-12-31'),
    });
  });
});

describe('duePeriods', () => {
  const periodicTime = { hour: 23, minute: 0 };
  // 되짚기를 끄고 "오늘이 주기 끝인가"만 본다. 밀린 경우는 따로 다룬다.
  const today = { periodicTime, cutoffHour: 4, lookbackDays: 0, donePeriods: [] };

  test('발송 시각 전에는 나오지 않는다', () => {
    // 일요일 22:00
    assert.deepEqual(duePeriods({ ...today, now: new Date(2026, 9, 4, 22, 0) }), []);
  });

  test('발송 시각이 지나면 나온다', () => {
    const due = duePeriods({ ...today, now: new Date(2026, 9, 4, 23, 5) });
    assert.equal(due.length, 1);
    assert.equal(due[0].cycle, 'weekly');
    assert.equal(due[0].end, '2026-10-04');
  });

  test('주기 끝이 아닌 날에는 아무것도 없다', () => {
    assert.deepEqual(duePeriods({ ...today, now: new Date(2026, 9, 3, 23, 5) }), []);
  });

  test('이미 보낸 주기는 빠진다', () => {
    const due = duePeriods({
      ...today,
      now: new Date(2026, 9, 4, 23, 5),
      donePeriods: [cycleKey('weekly', '2026-10-04')],
    });
    assert.deepEqual(due, []);
  });

  test('새벽에 깨어나면 전날 몫으로 친다', () => {
    // 10/5(월) 새벽 2시 — cutoffHour 4 이전이라 회고 날짜는 10/4(일)
    const due = duePeriods({ ...today, now: new Date(2026, 9, 5, 2, 0) });
    assert.deepEqual(due.map((p) => p.end), ['2026-10-04']);
  });

  test('며칠 꺼져 있었으면 밀린 주기가 오래된 순으로 나온다', () => {
    // 10/4(일)·10/11(일) 을 지나 10/13 에 깨어났다. 그 앞은 처리를 마쳤다.
    const due = duePeriods({
      periodicTime,
      cutoffHour: 4,
      lookbackDays: 10,
      now: new Date(2026, 9, 13, 9, 0),
      donePeriods: [],
    });
    assert.deepEqual(due.map((p) => p.end), ['2026-10-04', '2026-10-11']);
  });

  test('한 달 넘게 꺼져 있어도 월말을 놓치지 않는다', () => {
    const due = duePeriods({
      periodicTime,
      cutoffHour: 4,
      now: new Date(2026, 10, 5, 9, 0),
      donePeriods: [],
    });
    assert.ok(due.some((p) => p.cycle === 'monthly' && p.end === '2026-10-31'));
  });

  test('처리를 마친 것만 빼고 나머지 밀린 것을 준다', () => {
    const due = duePeriods({
      periodicTime,
      cutoffHour: 4,
      lookbackDays: 10,
      now: new Date(2026, 9, 13, 9, 0),
      donePeriods: [cycleKey('weekly', '2026-10-04')],
    });
    assert.deepEqual(due.map((p) => p.end), ['2026-10-11']);
  });
});

describe('coveragePlan — 굵은 것부터 덮어간다', () => {
  const page = (id, date, cycle) => ({ id, date, cycle });
  const ids = (chosen) => chosen.map((p) => p.id);

  test('주간은 그 주의 일간을 모은다', () => {
    const range = rangeOf('weekly', '2026-10-04');
    const pages = daysBetween('2026-09-28', '2026-10-04').map((d, i) => page(`d${i}`, d, 'daily'));

    const chosen = coveragePlan({ cycle: 'weekly', range, pages });
    assert.equal(chosen.length, 7);
  });

  test('상위 주기 페이지가 있으면 그것을 쓰고 그 안의 일간은 건너뛴다', () => {
    const range = rangeOf('monthly', '2026-10-31');
    const pages = [
      page('w1', '2026-10-11', 'weekly'), // 10/5~10/11, 10월 안에 온전히 들어간다
      ...daysBetween('2026-10-05', '2026-10-11').map((d, i) => page(`d${i}`, d, 'daily')),
    ];

    assert.deepEqual(ids(coveragePlan({ cycle: 'monthly', range, pages })), ['w1']);
  });

  test('기간 밖으로 삐져나오는 페이지는 쓰지 않는다', () => {
    const range = rangeOf('monthly', '2026-10-31');
    // 9/28~10/4 주간은 9월을 물고 있어 10월 회고에 쓸 수 없다.
    // 대신 10/1~10/4 일간이 그 자리를 메운다.
    const pages = [
      page('w1', '2026-10-04', 'weekly'),
      ...daysBetween('2026-10-01', '2026-10-04').map((d) => page(`day-${d}`, d, 'daily')),
    ];

    const chosen = ids(coveragePlan({ cycle: 'monthly', range, pages }));
    assert.ok(!chosen.includes('w1'), '9월을 물고 있는 주간은 빠진다');
    assert.equal(chosen.length, 4, '일간 4개가 그 구간을 메운다');
  });

  test('같은 날을 두 번 넣지 않는다', () => {
    const range = rangeOf('monthly', '2026-10-31');
    const pages = [
      page('w', '2026-10-11', 'weekly'), // 10/5~10/11
      page('d', '2026-10-07', 'daily'), // 그 안에 들어간다
    ];

    const chosen = coveragePlan({ cycle: 'monthly', range, pages });
    assert.deepEqual(ids(chosen), ['w'], '굵은 쪽이 이기고 일간은 버려진다');
  });

  test('빈 구간만 잘게 메운다', () => {
    const range = rangeOf('monthly', '2026-10-31');
    const pages = [
      page('w', '2026-10-11', 'weekly'), // 10/5~10/11
      page('d1', '2026-10-01', 'daily'), // 주간 밖
      page('d2', '2026-10-12', 'daily'), // 주간 밖
    ];

    const chosen = coveragePlan({ cycle: 'monthly', range, pages });
    assert.deepEqual(ids(chosen), ['d1', 'w', 'd2'], '날짜순으로 돌려준다');
  });

  test('자기와 같거나 큰 주기는 재료로 쓰지 않는다', () => {
    const range = rangeOf('monthly', '2026-10-31');
    const pages = [page('m', '2026-10-31', 'monthly'), page('y', '2026-12-31', 'yearly')];

    assert.deepEqual(coveragePlan({ cycle: 'monthly', range, pages }), []);
  });

  test('12/31 연간 — 계층에 구멍이 나도 메운다', () => {
    // '가장 큰 주기 하나만' 탓에 12월 월간·4분기·하반기 페이지는 없다.
    const range = rangeOf('yearly', '2026-12-31');
    const pages = [
      page('h1', '2026-06-30', 'half'), // 1~6월
      page('q3', '2026-09-30', 'quarterly'), // 7~9월
      page('m10', '2026-10-31', 'monthly'),
      page('m11', '2026-11-30', 'monthly'),
      ...daysBetween('2026-12-01', '2026-12-31').map((d) => page(`day-${d}`, d, 'daily')),
      // 이미 덮인 구간의 잔챙이들 — 집히면 안 된다.
      page('m01', '2026-01-31', 'monthly'),
      page('w', '2026-08-02', 'weekly'),
    ];

    const chosen = coveragePlan({ cycle: 'yearly', range, pages });
    const chosenIds = ids(chosen);

    assert.deepEqual(chosenIds.slice(0, 4), ['h1', 'q3', 'm10', 'm11']);
    assert.equal(chosenIds.length, 4 + 31, '12월은 일간 31개로 메운다');
    assert.ok(!chosenIds.includes('m01'), '상반기가 이미 덮었다');
    assert.ok(!chosenIds.includes('w'), '3분기가 이미 덮었다');
  });

  test('모르는 주기의 페이지는 무시한다', () => {
    const range = rangeOf('weekly', '2026-10-04');
    const pages = [page('x', '2026-10-01', '정체불명'), page('d', '2026-10-01', 'daily')];

    assert.deepEqual(ids(coveragePlan({ cycle: 'weekly', range, pages })), ['d']);
  });

  test('재료가 없으면 빈 배열', () => {
    assert.deepEqual(coveragePlan({ cycle: 'weekly', range: rangeOf('weekly', '2026-10-04'), pages: [] }), []);
  });

  test('모르는 목표 주기는 에러', () => {
    assert.throws(
      () => coveragePlan({ cycle: 'decade', range: { start: '2020-01-01', end: '2029-12-31' }, pages: [] }),
      /알 수 없는 주기/,
    );
  });
});
