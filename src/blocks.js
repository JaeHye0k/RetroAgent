/**
 * RetroDraft → 노션 블록 변환. 전부 순수 함수라 단위 테스트로 검증한다.
 *
 * 기존 일간 회고 페이지의 생김새를 그대로 재현한다:
 *   ## 오늘 한 일            (heading_2, 텍스트 색 purple)
 *   > 가이드 문구            (quote, 블록 색 gray)
 *   **프로젝트명**            (paragraph, bold)
 *   - 항목
 *     - 발견: …              (중첩 불릿)
 *   ---                      (divider)
 *   ## 한 줄 배움 / 감정      (heading_2, 텍스트 색 green)
 *   > 가이드 문구
 *   - 항목
 */

/** 노션 rich_text 하나에 들어갈 수 있는 최대 길이 */
export const TEXT_LIMIT = 2000;

export const SECTIONS = {
  done: {
    title: '오늘 한 일',
    color: 'purple',
    guide: '오늘 있었던 일·활동을 사실 위주로 간단히 적습니다.',
  },
  learnings: {
    title: '한 줄 배움 / 감정',
    color: 'green',
    guide: '오늘 배운 것, 느낀 감정을 한 줄로 남깁니다. 감정이라면 그 원인도 함께 떠올려봅니다.',
  },
};

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

/** 새 페이지를 만들 때 쓰는 뼈대 */
export function scaffold() {
  return [
    heading2(SECTIONS.done.title, SECTIONS.done.color),
    guideQuote(SECTIONS.done.guide),
    divider(),
    heading2(SECTIONS.learnings.title, SECTIONS.learnings.color),
    guideQuote(SECTIONS.learnings.guide),
  ];
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

/** draft.learnings → 블록 */
export function learningBlocks(items = []) {
  return items
    .filter((item) => String(item?.text ?? '').trim())
    .map((item) => bullet(item.text.trim(), item.sub ?? []));
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
