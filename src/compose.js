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

const SYSTEM_PROMPT =
  '너는 한국어 회고 정리기다. 사용자가 준 조각글을 지정된 JSON 스키마에 맞춰 재구성한다. ' +
  '설명이나 인사말 없이 구조화된 결과만 낸다.';

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
    runner = spawnClaude,
    cwd = ROOT,
  } = {}) {
    this.bin = bin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.promptPath = promptPath;
    this.runner = runner;
    this.cwd = cwd;
  }

  async #instructions() {
    this.instructionsCache ??= await fs.readFile(this.promptPath, 'utf8');
    return this.instructionsCache;
  }

  /** 한 번 호출하고 결과를 검증한다. 검증 실패 시 errors 를 채워 돌려준다. */
  async #attempt(userPrompt) {
    const args = [
      '--print',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(RETRO_SCHEMA),
      '--system-prompt', SYSTEM_PROMPT,
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

    const errors = validateDraft(draft);
    return errors.length ? { errors, draft } : { draft };
  }

  /**
   * 조각글 → RetroDraft.
   * 한 번 실패하면 형식을 지적해 재시도하고, 그래도 안 되면 원문을 통째로
   * 넘기는 폴백을 돌려준다. 어떤 경로로도 조각글은 사라지지 않는다.
   */
  async compose({ fragments, dateString, existingText, extraInstruction }) {
    const instructions = await this.#instructions();
    const base = buildUserPrompt({ fragments, dateString, existingText, extraInstruction });

    let lastErrors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryNote =
        attempt === 0
          ? ''
          : `\n\n## 직전 시도가 형식 검증에 실패했다\n${lastErrors.join('\n')}\n스키마를 정확히 지켜 다시 출력하라.`;

      try {
        const { draft, errors } = await this.#attempt(`${instructions}\n\n---\n\n${base}${retryNote}`);
        if (draft && !errors?.length) {
          return { draft: { ...draft, date: dateString }, ok: true };
        }
        lastErrors = errors ?? ['알 수 없는 실패'];
      } catch (error) {
        lastErrors = [error.message];
      }
      console.error(`[compose] ${attempt + 1}차 시도 실패:`, lastErrors.join(' / '));
    }

    return {
      draft: fallbackDraft({ fragments, dateString }),
      ok: false,
      reason: `자동 정리에 실패했습니다 (${lastErrors[0] ?? '원인 불명'}). 원문 그대로 넣습니다.`,
    };
  }
}
