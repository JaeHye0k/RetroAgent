import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROMPTS_DIR, ROOT } from './config.js';

const bulletItem = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    sub: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'sub'],
  additionalProperties: false,
};

/** claude CLI 의 --json-schema 로 넘겨 구조화 출력을 강제한다. */
export const RETRO_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    done: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: ['string', 'null'] },
          bullets: { type: 'array', items: bulletItem },
        },
        required: ['group', 'bullets'],
        additionalProperties: false,
      },
    },
    learnings: { type: 'array', items: bulletItem },
    dropped: { type: 'array', items: { type: 'string' } },
  },
  required: ['date', 'done', 'learnings', 'dropped'],
  additionalProperties: false,
};

/**
 * 주기 회고(KLPT)용 스키마.
 *
 * 일간과 달리 조각글이 아니라 **이미 쓴 회고 페이지들**을 재료로 받는다.
 * tryReview 는 지난 주기에 적은 Try 가 실제로 실행됐는지에 대한 판단이다.
 */
export const PERIOD_SCHEMA = {
  type: 'object',
  properties: {
    period: { type: 'string' },
    tryReview: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          done: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['text', 'done', 'note'],
        additionalProperties: false,
      },
    },
    keep: { type: 'array', items: bulletItem },
    problem: { type: 'array', items: bulletItem },
    learned: { type: 'array', items: bulletItem },
    try: { type: 'array', items: bulletItem },
  },
  required: ['period', 'tryReview', 'keep', 'problem', 'learned', 'try'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  '너는 한국어 회고 정리기다. 사용자가 준 조각글을 지정된 JSON 스키마에 맞춰 재구성한다. ' +
  '설명이나 인사말 없이 구조화된 결과만 낸다.';

const PERIOD_SYSTEM_PROMPT =
  '너는 한국어 회고 정리기다. 사용자가 기간 동안 써 둔 회고들을 읽고 KLPT 형식의 주기 회고로 ' +
  '간추린다. 설명이나 인사말 없이 구조화된 결과만 낸다.';

export function validateDraft(value) {
  const errors = [];
  const isBullet = (item) =>
    item &&
    typeof item.text === 'string' &&
    Array.isArray(item.sub) &&
    item.sub.every((s) => typeof s === 'string');

  if (!value || typeof value !== 'object') return ['최상위가 객체가 아닙니다'];
  if (typeof value.date !== 'string') errors.push('date 가 문자열이 아닙니다');
  if (!Array.isArray(value.done)) errors.push('done 이 배열이 아닙니다');
  else {
    value.done.forEach((group, i) => {
      if (group?.group != null && typeof group.group !== 'string') errors.push(`done[${i}].group 타입 오류`);
      if (!Array.isArray(group?.bullets)) errors.push(`done[${i}].bullets 가 배열이 아닙니다`);
      else if (!group.bullets.every(isBullet)) errors.push(`done[${i}].bullets 항목 형식 오류`);
    });
  }
  if (!Array.isArray(value.learnings)) errors.push('learnings 가 배열이 아닙니다');
  else if (!value.learnings.every(isBullet)) errors.push('learnings 항목 형식 오류');
  if (!Array.isArray(value.dropped)) errors.push('dropped 가 배열이 아닙니다');
  else if (!value.dropped.every((d) => typeof d === 'string')) errors.push('dropped 항목이 문자열이 아닙니다');

  return errors;
}

/**
 * 자동 정리가 실패했을 때 쓰는 안전망.
 * 조각글을 하나도 잃지 않고 전부 dropped 로 넘겨 사람이 판단하게 한다.
 */
export function fallbackDraft({ fragments, dateString }) {
  return {
    date: dateString,
    done: [],
    learnings: [],
    dropped: fragments.map((f) => f.text),
  };
}

export function validatePeriodDraft(value) {
  const errors = [];
  const isBullet = (item) =>
    item &&
    typeof item.text === 'string' &&
    Array.isArray(item.sub) &&
    item.sub.every((s) => typeof s === 'string');

  if (!value || typeof value !== 'object') return ['최상위가 객체가 아닙니다'];
  if (typeof value.period !== 'string') errors.push('period 가 문자열이 아닙니다');

  if (!Array.isArray(value.tryReview)) errors.push('tryReview 가 배열이 아닙니다');
  else {
    value.tryReview.forEach((item, i) => {
      if (typeof item?.text !== 'string') errors.push(`tryReview[${i}].text 타입 오류`);
      if (typeof item?.done !== 'boolean') errors.push(`tryReview[${i}].done 이 boolean 이 아닙니다`);
      if (typeof item?.note !== 'string') errors.push(`tryReview[${i}].note 타입 오류`);
    });
  }

  for (const key of ['keep', 'problem', 'learned', 'try']) {
    if (!Array.isArray(value[key])) errors.push(`${key} 가 배열이 아닙니다`);
    else if (!value[key].every(isBullet)) errors.push(`${key} 항목 형식 오류`);
  }

  return errors;
}

export function buildUserPrompt({ fragments, dateString, existingText, extraInstruction }) {
  const parts = [`## 회고 날짜\n${dateString}`];

  parts.push(
    `## 오늘 들어온 조각글 (${fragments.length}개)\n` +
      fragments
        .map((f, i) => {
          const time = new Date(f.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. [${time}] ${f.text}`;
        })
        .join('\n'),
  );

  if (existingText?.trim()) {
    parts.push(`## 이미 저장된 내용 (중복해서 쓰지 말 것)\n${existingText.trim()}`);
  }
  if (extraInstruction?.trim()) {
    parts.push(`## 추가 지시\n${extraInstruction.trim()}`);
  }

  return parts.join('\n\n');
}

/** 주기 회고 프롬프트. 재료는 조각글이 아니라 이미 써 둔 회고 페이지들이다. */
export function buildPeriodPrompt({ title, cycleName, range, sources, previousTry }) {
  const parts = [`## 이번 회고\n${title} (${cycleName} · ${range.start} ~ ${range.end})`];

  parts.push(
    `## 재료 — 이 기간에 쓴 회고 ${sources.length}개\n` +
      sources.map((s) => `### ${s.title}\n${s.text.trim() || '(내용 없음)'}`).join('\n\n'),
  );

  parts.push(
    previousTry?.trim()
      ? `## 지난 ${cycleName} 회고의 Try\n${previousTry.trim()}\n\n` +
          '각 항목이 위 재료에서 실제로 실행됐는지 판단해 tryReview 에 넣어라.'
      : `## 지난 ${cycleName} 회고의 Try\n없다 (이번이 첫 ${cycleName} 회고다). tryReview 는 빈 배열로 둔다.`,
  );

  return parts.join('\n\n');
}

/** claude CLI 를 자식 프로세스로 돌린다. 테스트에서는 runner 를 갈아끼운다. */
export async function spawnClaude({ bin, args, input, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${bin} 실행 실패: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${bin} 가 ${timeoutMs}ms 안에 끝나지 않아 종료했습니다`));
      else resolve({ code, stdout, stderr });
    });

    child.stdin.end(input, 'utf8');
  });
}

export class Composer {
  constructor({
    bin = 'claude',
    model = 'sonnet',
    timeoutMs = 240_000,
    promptPath = path.join(PROMPTS_DIR, 'compose.md'),
    periodPromptPath = path.join(PROMPTS_DIR, 'compose-period.md'),
    runner = spawnClaude,
    cwd = ROOT,
  } = {}) {
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.promptPath = promptPath;
    this.periodPromptPath = periodPromptPath;
    this.runner = runner;
    this.cwd = cwd;
    this.instructionsCache = new Map();
  }

  async #instructions(file) {
    if (!this.instructionsCache.has(file)) {
      this.instructionsCache.set(file, await fs.readFile(file, 'utf8'));
    }
    return this.instructionsCache.get(file);
  }

  /** 한 번 호출하고 결과를 검증한다. 검증 실패 시 errors 를 채워 돌려준다. */
  async #attempt(userPrompt, { schema, systemPrompt, validate }) {
    const args = [
      '--print',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--system-prompt', systemPrompt,
      '--model', this.model,
      // 회고 정리는 순수 텍스트 변환이다. 도구도, 사용자 설정도 끼어들 이유가 없다.
      '--tools', '',
      '--safe-mode',
      '--no-session-persistence',
    ];

    const { code, stdout, stderr } = await this.runner({
      bin: this.bin,
      args,
      input: userPrompt,
      timeoutMs: this.timeoutMs,
      cwd: this.cwd,
    });

    if (code !== 0) {
      return { errors: [`claude 가 종료 코드 ${code} 로 끝났습니다: ${stderr.trim().slice(0, 300)}`] };
    }

    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return { errors: [`claude 출력이 JSON 이 아닙니다: ${stdout.trim().slice(0, 300)}`] };
    }

    if (envelope.is_error) {
      return { errors: [`claude 오류: ${String(envelope.result ?? '').slice(0, 300)}`] };
    }

    let draft = envelope.structured_output;
    if (draft === undefined) {
      try {
        draft = JSON.parse(envelope.result);
      } catch {
        return { errors: ['응답에 structured_output 이 없고 result 도 JSON 이 아닙니다'] };
      }
    }

    const errors = validate(draft);
    return errors.length ? { errors, draft } : { draft };
  }

  /**
   * 형식이 맞을 때까지 두 번 시도한다. 두 번째에는 무엇이 틀렸는지 알려준다.
   * @returns 성공하면 `{ draft }`, 끝내 실패하면 `{ errors }`
   */
  async #runWithRetry(prompt, options, label) {
    let lastErrors = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryNote =
        attempt === 0
          ? ''
          : `\n\n## 직전 시도가 형식 검증에 실패했다\n${lastErrors.join('\n')}\n스키마를 정확히 지켜 다시 출력하라.`;

      try {
        const { draft, errors } = await this.#attempt(`${prompt}${retryNote}`, options);
        if (draft && !errors?.length) return { draft };
        lastErrors = errors ?? ['알 수 없는 실패'];
      } catch (error) {
        lastErrors = [error.message];
      }
      console.error(`[${label}] ${attempt + 1}차 시도 실패:`, lastErrors.join(' / '));
    }

    return { errors: lastErrors };
  }

  /**
   * 조각글 → RetroDraft.
   * 끝내 실패하면 원문을 통째로 넘기는 폴백을 돌려준다.
   * 어떤 경로로도 조각글은 사라지지 않는다.
   */
  async compose({ fragments, dateString, existingText, extraInstruction }) {
    const instructions = await this.#instructions(this.promptPath);
    const base = buildUserPrompt({ fragments, dateString, existingText, extraInstruction });

    const { draft, errors } = await this.#runWithRetry(
      `${instructions}\n\n---\n\n${base}`,
      { schema: RETRO_SCHEMA, systemPrompt: SYSTEM_PROMPT, validate: validateDraft },
      'compose',
    );

    if (draft) return { draft: { ...draft, date: dateString }, ok: true };

    return {
      draft: fallbackDraft({ fragments, dateString }),
      ok: false,
      reason: `자동 정리에 실패했습니다 (${errors[0] ?? '원인 불명'}). 원문 그대로 넣습니다.`,
    };
  }

  /**
   * 이미 쓴 회고들 → 주기 회고(KLPT) 초안.
   *
   * 일간과 달리 **폴백이 없다**. 일간은 실패하면 조각글이 유실될 수 있어 원문을
   * 통째로라도 넣어야 하지만, 주기 회고의 재료는 이미 노션에 영구히 있다.
   * 억지로 빈 페이지를 만드는 것보다 실패했다고 말하는 편이 낫다.
   */
  async composePeriod({ title, cycleName, range, sources, previousTry }) {
    const instructions = await this.#instructions(this.periodPromptPath);
    const base = buildPeriodPrompt({ title, cycleName, range, sources, previousTry });

    const { draft, errors } = await this.#runWithRetry(
      `${instructions}\n\n---\n\n${base}`,
      { schema: PERIOD_SCHEMA, systemPrompt: PERIOD_SYSTEM_PROMPT, validate: validatePeriodDraft },
      'compose-period',
    );

    if (draft) return { draft: { ...draft, period: title }, ok: true };
    return { ok: false, reason: `주기 회고 정리에 실패했습니다 (${errors[0] ?? '원인 불명'}).` };
  }
}
