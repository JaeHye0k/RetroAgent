import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { handleCommand, parseSelection } from '../src/commands.js';

describe('parseSelection', () => {
  test('숫자 하나', () => {
    assert.deepEqual(parseSelection('2'), [2]);
  });

  test('띄어쓰기·쉼표로 여러 개', () => {
    assert.deepEqual(parseSelection('2 5'), [2, 5]);
    assert.deepEqual(parseSelection('5,2'), [2, 5]);
  });

  test('범위', () => {
    assert.deepEqual(parseSelection('2-4'), [2, 3, 4]);
    assert.deepEqual(parseSelection('2 - 4'), [2, 3, 4], '띄어 쓴 범위도 읽는다');
    assert.deepEqual(parseSelection('4~2'), [2, 3, 4], '거꾸로 써도 읽는다');
  });

  test('중복은 한 번만, 오름차순으로', () => {
    assert.deepEqual(parseSelection('5 2-4 3'), [2, 3, 4, 5]);
  });

  test('빈 인자는 null', () => {
    assert.equal(parseSelection(''), null);
    assert.equal(parseSelection(undefined), null);
  });

  test('하나라도 못 읽으면 통째로 null — 절반만 지우지 않는다', () => {
    assert.equal(parseSelection('2 어쩌구'), null);
    assert.equal(parseSelection('-3'), null);
    assert.equal(parseSelection('2.5'), null);
  });

  test('0 번은 없다', () => {
    assert.equal(parseSelection('0'), null);
    assert.equal(parseSelection('0-3'), null);
  });

  test('터무니없이 넓은 범위는 오타로 본다', () => {
    assert.equal(parseSelection('1-99999'), null);
  });
});

/** pipeline 대역 — 어떤 메서드가 어떤 인자로 불렸는지만 기록한다. */
function fakePipeline() {
  const calls = [];
  return {
    calls,
    said: [],
    async runDigest() {
      calls.push(['runDigest']);
    },
    async showQueue() {
      calls.push(['showQueue']);
    },
    async dropFragments(numbers) {
      calls.push(['dropFragments', numbers]);
    },
    async confirmClear() {
      calls.push(['confirmClear']);
    },
    async undo() {
      calls.push(['undo']);
    },
    async say(text) {
      calls.push(['say']);
      this.said.push(text);
    },
  };
}

const config = { digestTime: { hour: 23, minute: 0 } };

describe('handleCommand — /drop', () => {
  test('번호를 파싱해 dropFragments 로 넘긴다', async () => {
    const pipeline = fakePipeline();
    assert.equal(await handleCommand('/drop 2 5', { pipeline, config }), true);
    assert.deepEqual(pipeline.calls, [['dropFragments', [2, 5]]]);
  });

  test('/rm 도 같은 명령이다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/rm 3', { pipeline, config });
    assert.deepEqual(pipeline.calls, [['dropFragments', [3]]]);
  });

  test('인자가 없으면 큐를 건드리지 않고 사용법을 알려준다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/drop', { pipeline, config });
    assert.deepEqual(pipeline.calls, [['say']]);
    assert.match(pipeline.said[0], /\/queue 에 보이는 번호/);
  });

  test('읽을 수 없는 인자도 사용법으로 막는다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/drop 두번째', { pipeline, config });
    assert.deepEqual(pipeline.calls, [['say']]);
  });

  test('그룹에서 오는 /drop@봇이름 형태도 받는다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/drop@retro_bot 4', { pipeline, config });
    assert.deepEqual(pipeline.calls, [['dropFragments', [4]]]);
  });
});

describe('handleCommand — /clear', () => {
  test('바로 비우지 않고 확인 절차로 넘긴다', async () => {
    const pipeline = fakePipeline();
    assert.equal(await handleCommand('/clear', { pipeline, config }), true);
    assert.deepEqual(pipeline.calls, [['confirmClear']]);
  });
});

describe('handleCommand — 기존 명령', () => {
  test('인자가 붙어도 명령은 그대로 라우팅된다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/now 지금', { pipeline, config });
    assert.deepEqual(pipeline.calls, [['runDigest']]);
  });

  test('도움말에 /drop 과 /clear 가 있다', async () => {
    const pipeline = fakePipeline();
    await handleCommand('/help', { pipeline, config });
    assert.match(pipeline.said[0], /\/drop/);
    assert.match(pipeline.said[0], /\/clear/);
  });

  test('명령이 아니면 false — 조각글로 흘려보낸다', async () => {
    const pipeline = fakePipeline();
    assert.equal(await handleCommand('/ 그냥 슬래시', { pipeline, config }), false);
    assert.deepEqual(pipeline.calls, []);
  });
});
