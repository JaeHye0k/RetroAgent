process.env.TZ = 'Asia/Seoul';

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildUserPrompt, Composer, fallbackDraft, RETRO_SCHEMA, validateDraft } from '../src/compose.js';

const fragments = [
  { id: 1, ts: '2026-07-26T14:03:00+09:00', text: '담기 버튼 버그 수정함' },
  { id: 2, ts: '2026-07-26T20:11:00+09:00', text: 'staleTime 과 gcTime 을 헷갈리고 있었다' },
];

const validDraft = {
  date: '2026-07-26',
  done: [{ group: '장바구니 개선', bullets: [{ text: '담기 버튼 버그 수정', sub: [] }] }],
  learnings: [{ text: 'staleTime 과 gcTime 을 헷갈리고 있었다', sub: [] }],
  dropped: [],
};

/** claude CLI 응답 봉투를 흉내낸다. */
const envelope = (structured) => ({
  code: 0,
  stdout: JSON.stringify({ is_error: false, result: JSON.stringify(structured), structured_output: structured }),
  stderr: '',
});

describe('validateDraft', () => {
  test('올바른 draft 는 오류 없음', () => {
    assert.deepEqual(validateDraft(validDraft), []);
  });

  test('객체가 아니면 잡아낸다', () => {
    assert.deepEqual(validateDraft(null), ['최상위가 객체가 아닙니다']);
    assert.deepEqual(validateDraft('문자열'), ['최상위가 객체가 아닙니다']);
  });

  test('필수 필드 누락을 잡아낸다', () => {
    const errors = validateDraft({ date: '2026-07-26' });
    assert.ok(errors.some((e) => e.includes('done')));
    assert.ok(errors.some((e) => e.includes('learnings')));
    assert.ok(errors.some((e) => e.includes('dropped')));
  });

  test('sub 가 배열이 아니면 잡아낸다', () => {
    const errors = validateDraft({ ...validDraft, learnings: [{ text: 'x', sub: '아님' }] });
    assert.ok(errors.some((e) => e.includes('learnings 항목 형식 오류')));
  });

  test('group 은 null 을 허용한다', () => {
    assert.deepEqual(validateDraft({ ...validDraft, done: [{ group: null, bullets: [] }] }), []);
  });

  test('group 이 숫자면 잡아낸다', () => {
    const errors = validateDraft({ ...validDraft, done: [{ group: 7, bullets: [] }] });
    assert.ok(errors.some((e) => e.includes('group 타입 오류')));
  });

  test('dropped 에 문자열이 아닌 값이 있으면 잡아낸다', () => {
    const errors = validateDraft({ ...validDraft, dropped: [{ text: 'x' }] });
    assert.ok(errors.some((e) => e.includes('dropped 항목이 문자열이 아닙니다')));
  });
});

describe('RETRO_SCHEMA', () => {
  test('claude --json-schema 에 넘길 수 있는 형태다', () => {
    assert.equal(RETRO_SCHEMA.type, 'object');
    assert.deepEqual(RETRO_SCHEMA.required, ['date', 'done', 'learnings', 'dropped']);
    assert.equal(RETRO_SCHEMA.additionalProperties, false);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(RETRO_SCHEMA)));
  });
});

describe('fallbackDraft — 조각글은 유실되지 않는다', () => {
  test('모든 원문이 dropped 로 넘어간다', () => {
    const draft = fallbackDraft({ fragments, dateString: '2026-07-26' });
    assert.deepEqual(draft.dropped, ['담기 버튼 버그 수정함', 'staleTime 과 gcTime 을 헷갈리고 있었다']);
    assert.deepEqual(draft.done, []);
    assert.equal(draft.date, '2026-07-26');
  });
});

describe('buildUserPrompt', () => {
  test('날짜·조각글·시각을 담는다', () => {
    const prompt = buildUserPrompt({ fragments, dateString: '2026-07-26' });
    assert.match(prompt, /## 회고 날짜\n2026-07-26/);
    assert.match(prompt, /조각글 \(2개\)/);
    assert.match(prompt, /담기 버튼 버그 수정함/);
    assert.match(prompt, /1\. \[.*\]/);
  });

  test('기존 내용이 있으면 중복 금지 지시와 함께 넣는다', () => {
    const prompt = buildUserPrompt({ fragments, dateString: '2026-07-26', existingText: '- 이미 적힌 항목' });
    assert.match(prompt, /이미 저장된 내용/);
    assert.match(prompt, /이미 적힌 항목/);
  });

  test('기존 내용이 비면 그 절을 넣지 않는다', () => {
    const prompt = buildUserPrompt({ fragments, dateString: '2026-07-26', existingText: '   ' });
    assert.equal(prompt.includes('이미 저장된 내용'), false);
  });

  test('추가 지시를 붙인다', () => {
    const prompt = buildUserPrompt({ fragments, dateString: '2026-07-26', extraInstruction: '다시 정리하라' });
    assert.match(prompt, /## 추가 지시\n다시 정리하라/);
  });
});

describe('Composer.compose', () => {
  const composerWith = (runner) =>
    new Composer({ runner, promptPath: new URL('../prompts/compose.md', import.meta.url).pathname });

  test('한 번에 성공하면 draft 를 돌려준다', async () => {
    let calls = 0;
    const composer = composerWith(async () => {
      calls += 1;
      return envelope(validDraft);
    });

    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(result.draft.learnings, validDraft.learnings);
  });

  test('date 는 항상 우리가 계산한 값으로 덮어쓴다', async () => {
    const composer = composerWith(async () => envelope({ ...validDraft, date: '1999-01-01' }));
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.draft.date, '2026-07-26');
  });

  test('형식이 틀리면 한 번 재시도하고, 두 번째가 맞으면 성공', async () => {
    let calls = 0;
    const composer = composerWith(async ({ input }) => {
      calls += 1;
      if (calls === 1) return envelope({ date: '2026-07-26', done: '배열아님' });
      // 재시도 프롬프트에는 형식 지적이 들어가 있어야 한다.
      assert.match(input, /형식 검증에 실패했다/);
      return envelope(validDraft);
    });

    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  });

  test('두 번 다 실패하면 폴백으로 원문을 전부 보존한다', async () => {
    let calls = 0;
    const composer = composerWith(async () => {
      calls += 1;
      return envelope({ 엉뚱한: '모양' });
    });

    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, false);
    assert.equal(calls, 2);
    assert.equal(result.draft.dropped.length, fragments.length);
    assert.match(result.reason, /자동 정리에 실패/);
  });

  test('claude 가 0 이 아닌 코드로 죽어도 폴백한다', async () => {
    const composer = composerWith(async () => ({ code: 1, stdout: '', stderr: '뭔가 터졌다' }));
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, false);
    assert.equal(result.draft.dropped.length, 2);
  });

  test('stdout 이 JSON 이 아니어도 폴백한다', async () => {
    const composer = composerWith(async () => ({ code: 0, stdout: 'JSON 아님', stderr: '' }));
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, false);
  });

  test('runner 가 예외를 던져도 폴백한다 (claude 미설치 등)', async () => {
    const composer = composerWith(async () => {
      throw new Error('claude 실행 실패: ENOENT');
    });
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ENOENT/);
  });

  test('structured_output 이 없으면 result 문자열을 파싱한다', async () => {
    const composer = composerWith(async () => ({
      code: 0,
      stdout: JSON.stringify({ is_error: false, result: JSON.stringify(validDraft) }),
      stderr: '',
    }));
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, true);
  });

  test('is_error 응답은 실패로 본다', async () => {
    const composer = composerWith(async () => ({
      code: 0,
      stdout: JSON.stringify({ is_error: true, result: '사용량 한도 초과' }),
      stderr: '',
    }));
    const result = await composer.compose({ fragments, dateString: '2026-07-26' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /사용량 한도 초과/);
  });

  test('필수 CLI 플래그를 빠뜨리지 않는다', async () => {
    let seen;
    const composer = composerWith(async ({ args }) => {
      seen = args;
      return envelope(validDraft);
    });
    await composer.compose({ fragments, dateString: '2026-07-26' });

    for (const flag of ['--print', '--output-format', '--json-schema', '--safe-mode', '--tools']) {
      assert.ok(seen.includes(flag), `${flag} 가 없습니다`);
    }
    assert.equal(seen[seen.indexOf('--output-format') + 1], 'json');
    assert.equal(seen[seen.indexOf('--tools') + 1], '');
  });
});
