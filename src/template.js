/**
 * 노션 페이지의 생김새를 templates/*.md 에서 읽어온다.
 *
 * 섹션 순서·제목·색·가이드 문구가 코드가 아니라 마크다운 파일에 있다.
 * 회고 템플릿을 손보고 싶으면 md 만 고치면 된다 — prompts/compose.md 와 같은 이유다.
 *
 * 지원하는 문법은 템플릿이 실제로 쓰는 것뿐이다:
 *
 *   ## 제목 {purple}    heading_2 — {…} 는 텍스트 색, 생략하면 default
 *   > 문구              quote (gray). 연속된 > 줄은 한 블록으로 합친다
 *   - 항목              bulleted_list_item
 *     - 하위            들여쓰면 바로 위 항목의 자식
 *   - [ ] 할 일         to_do (- [x] 면 체크됨)
 *   ---                 divider
 *
 * 모르는 문법을 만나면 조용히 넘기지 않고 에러를 던진다. 템플릿이 의도대로
 * 해석되지 않은 채 노션에 올라가는 쪽이 더 나쁘다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { bullet, divider, guideQuote, heading2, todo } from './blocks.js';
import { TEMPLATES_DIR } from './config.js';
import { CYCLES } from './cycles.js';

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const HEADING = /^##\s+(.+?)(?:\s*\{([a-z_]+)\})?$/;
const DIVIDER = /^-{3,}$/;
const LIST_ITEM = /^(\s*)[-*]\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*(.*)$/;

/** 불릿 한 줄 → 블록. `[ ]` 로 시작하면 체크박스가 된다. */
function listItem(text) {
  const checkbox = CHECKBOX.exec(text);
  if (checkbox) return todo(checkbox[2], { checked: checkbox[1].toLowerCase() === 'x' });
  return bullet(text);
}

/** 블록에 자식 하나를 매단다. 블록 타입에 따라 담기는 자리가 다르다. */
function appendChild(block, text) {
  const body = block[block.type];
  body.children ??= [];
  body.children.push(bullet(text));
}

/**
 * 마크다운 → `{ blocks, sections }`.
 * `sections` 는 등장 순서대로의 `{ title, color }` — 섹션 제목 검증에 쓴다.
 */
export function parseTemplate(markdown) {
  const blocks = [];
  const sections = [];

  let quote = [];
  let lastItem = null;

  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(guideQuote(quote.join('\n')));
    quote = [];
  };

  markdown.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    const lineNo = index + 1;

    if (!line.trim()) {
      flushQuote();
      return;
    }

    // 연속된 > 줄은 한 인용 블록으로 합친다.
    if (line.trimStart().startsWith('>')) {
      quote.push(line.trimStart().slice(1).trim());
      return;
    }
    flushQuote();

    const heading = HEADING.exec(line);
    if (heading) {
      const title = heading[1].trim();
      const color = heading[2] ?? 'default';
      blocks.push(heading2(title, color));
      sections.push({ title, color });
      lastItem = null;
      return;
    }

    if (DIVIDER.test(line.trim())) {
      blocks.push(divider());
      lastItem = null;
      return;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const [, indent, text] = item;
      if (!indent) {
        lastItem = listItem(text);
        blocks.push(lastItem);
      } else if (lastItem) {
        appendChild(lastItem, text);
      } else {
        throw new TemplateError(`${lineNo}번째 줄: 부모 없는 들여쓴 항목입니다 — "${line.trim()}"`);
      }
      return;
    }

    throw new TemplateError(`${lineNo}번째 줄을 해석할 수 없습니다 — "${line.trim()}"`);
  });

  flushQuote();
  return { blocks, sections };
}

/** 섹션 heading 과 그 아래 가이드 인용문. 섹션이 통째로 없는 페이지에 끼워넣을 때 쓴다. */
export function sectionBlocks(template, title) {
  const start = template.blocks.findIndex(
    (block) => block.type === 'heading_2' && headingTitle(block) === title,
  );
  if (start === -1) return null;

  const preamble = [template.blocks[start]];
  for (let i = start + 1; i < template.blocks.length; i += 1) {
    if (template.blocks[i].type !== 'quote') break;
    preamble.push(template.blocks[i]);
  }
  return preamble;
}

function headingTitle(block) {
  return (block.heading_2?.rich_text ?? []).map((rt) => rt.text?.content ?? '').join('').trim();
}

/**
 * 주기가 기대하는 섹션이 템플릿에 전부 있는지 본다.
 * md 에서 제목을 바꾸면 노션에 올리기 전에, 시작하자마자 알 수 있어야 한다.
 */
function assertSections(template, cycle) {
  const present = new Set(template.sections.map((s) => s.title));
  const missing = Object.values(CYCLES[cycle].sections).filter((title) => !present.has(title));

  if (missing.length) {
    throw new TemplateError(
      `templates/${CYCLES[cycle].template} 에 ${CYCLES[cycle].name} 회고가 쓸 섹션이 없습니다: ` +
        `${missing.join(', ')}\n(있는 섹션: ${[...present].join(', ') || '없음'})`,
    );
  }
}

const cache = new Map();

/** 테스트에서 다른 디렉터리를 쓸 때 캐시를 비운다. */
export function clearTemplateCache() {
  cache.clear();
}

/** 주기의 템플릿을 읽어 파싱한다. 파일은 한 번만 읽는다. */
export async function loadTemplate(cycle, { dir = TEMPLATES_DIR } = {}) {
  const spec = CYCLES[cycle];
  if (!spec) throw new TemplateError(`알 수 없는 주기: ${cycle}`);

  const file = path.join(dir, spec.template);
  if (!cache.has(file)) {
    let markdown;
    try {
      markdown = await fs.readFile(file, 'utf8');
    } catch (error) {
      throw new TemplateError(`템플릿을 읽지 못했습니다: ${file} (${error.message})`);
    }
    cache.set(file, parseTemplate(markdown));
  }

  const template = cache.get(file);
  assertSections(template, cycle);
  return template;
}

/** 새 페이지를 만들 때 쓰는 뼈대 */
export async function scaffoldFor(cycle, options) {
  return (await loadTemplate(cycle, options)).blocks;
}
