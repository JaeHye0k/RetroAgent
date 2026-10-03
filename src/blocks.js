/**
 * 초안 → 노션 블록 변환. 전부 순수 함수라 단위 테스트로 검증한다.
 *
 * 여기 있는 것은 **생성된 내용**을 블록으로 바꾸는 일뿐이다. 페이지의 생김새
 * (섹션 순서·제목·색·가이드 문구)는 templates/*.md 가 쥐고 있다 — src/template.js 참고.
 *
 *   **프로젝트명**            (paragraph, bold)
 *   - 항목
 *     - 발견: …              (중첩 불릿)
 *   - [ ] 액션 아이템          (to_do — 주기 회고의 Try)
 */

/** 노션 rich_text 하나에 들어갈 수 있는 최대 길이 */
export const TEXT_LIMIT = 2000;

export const DROPPED_LABEL = '미분류 — 자동 정리가 어느 섹션인지 판단하지 못한 원문';

/** 긴 문자열을 TEXT_LIMIT 이하 조각으로 나눠 rich_text 배열을 만든다. */
export function richText(content, annotations) {
  const text = String(content ?? '');
  if (!text) return [];

  const chunks = [];
  for (let i = 0; i < text.length; i += TEXT_LIMIT) {
    chunks.push(text.slice(i, i + TEXT_LIMIT));
  }

  return chunks.map((chunk) => {
    const item = { type: 'text', text: { content: chunk } };
    if (annotations) item.annotations = annotations;
    return item;
  });
}

export function heading2(title, color) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText(title, { color }) },
  };
}

export function guideQuote(text) {
  return {
    object: 'block',
    type: 'quote',
    quote: { rich_text: richText(text), color: 'gray' },
  };
}

export function divider() {
  return { object: 'block', type: 'divider', divider: {} };
}

export function boldParagraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(text, { bold: true }) },
  };
}

export function bullet(text, sub = []) {
  const block = {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(text) },
  };
  const children = sub.filter((s) => String(s ?? '').trim()).map((s) => bullet(s));
  if (children.length) block.bulleted_list_item.children = children;
  return block;
}

/**
 * 체크박스 항목. 주기 회고의 Try 와 '지난 주기 Try 점검' 이 쓴다.
 *
 * Try 를 체크박스로 두는 이유: 기간 중에 체크해 두면 다음 주기 회고가
 * 그 상태를 그대로 읽어 실행 여부를 점검할 수 있다.
 */
export function todo(text, { checked = false, sub = [] } = {}) {
  const block = {
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: richText(text), checked },
  };
  const children = sub.filter((s) => String(s ?? '').trim()).map((s) => bullet(s));
  if (children.length) block.to_do.children = children;
  return block;
}

/** draft.done → 블록. group 이 있으면 굵은 소제목으로 묶는다. */
export function doneBlocks(groups = []) {
  const blocks = [];
  for (const group of groups) {
    const bullets = (group?.bullets ?? []).filter((b) => String(b?.text ?? '').trim());
    if (!bullets.length) continue;
    if (String(group?.group ?? '').trim()) blocks.push(boldParagraph(group.group.trim()));
    for (const item of bullets) blocks.push(bullet(item.text.trim(), item.sub ?? []));
  }
  return blocks;
}

/** `{ text, sub }` 목록 → 불릿 블록. learnings·Keep·Problem·Learned 가 모두 이 모양이다. */
export function bulletBlocks(items = []) {
  return items
    .filter((item) => String(item?.text ?? '').trim())
    .map((item) => bullet(item.text.trim(), item.sub ?? []));
}

/** draft.learnings → 블록 */
export const learningBlocks = bulletBlocks;

/** 주기 회고의 Try → 체크박스. 기간 중 체크해 두면 다음 주기가 그 상태를 읽는다. */
export function tryBlocks(items = []) {
  return items
    .filter((item) => String(item?.text ?? '').trim())
    .map((item) => todo(item.text.trim(), { sub: item.sub ?? [] }));
}

/**
 * '지난 주기 Try 점검' → 체크박스.
 * 실행 여부는 체크 상태로, 그렇게 판단한 근거는 부연으로 내린다.
 */
export function tryReviewBlocks(items = []) {
  return items
    .filter((item) => String(item?.text ?? '').trim())
    .map((item) =>
      todo(item.text.trim(), {
        checked: Boolean(item.done),
        sub: String(item.note ?? '').trim() ? [item.note.trim()] : [],
      }),
    );
}

/** draft.dropped → 블록. 분류에 실패해도 원문은 반드시 페이지에 남긴다. */
export function droppedBlocks(items = []) {
  const texts = items.map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!texts.length) return [];
  return [boldParagraph(DROPPED_LABEL), ...texts.map((text) => bullet(text))];
}

/** heading_2 블록에서 제목 문자열을 뽑는다. */
export function headingText(block) {
  if (block?.type !== 'heading_2') return null;
  return (block.heading_2?.rich_text ?? []).map((rt) => rt.plain_text ?? rt.text?.content ?? '').join('').trim();
}
