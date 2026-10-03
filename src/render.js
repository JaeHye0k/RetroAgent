import { DAILY_SECTIONS, PERIOD_SECTIONS } from './cycles.js';
import { humanDate } from './schedule.js';

/** 텔레그램 메시지 1건 최대 길이 */
export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** 긴 텍스트를 줄 경계에서 잘라 여러 메시지로 나눈다. */
export function splitForTelegram(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];

  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    // 한 줄이 통째로 한도를 넘으면 그 줄만 강제로 쪼갠다.
    if (line.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** 정리 결과 미리보기. parse_mode: HTML 로 보낸다. */
export function renderPreview(draft, { fragmentCount, note } = {}) {
  const lines = [];
  lines.push(`📝 <b>${escapeHtml(draft.date)} 일간 회고</b>`);
  lines.push(`<i>${escapeHtml(humanDate(draft.date))} · 조각 ${fragmentCount ?? 0}개</i>`);
  if (note) lines.push('', `⚠️ ${escapeHtml(note)}`);

  const doneGroups = (draft.done ?? []).filter((g) => (g?.bullets ?? []).length);
  if (doneGroups.length) {
    lines.push('', `━━ <b>${escapeHtml(DAILY_SECTIONS.done)}</b>`);
    for (const group of doneGroups) {
      if (String(group.group ?? '').trim()) lines.push(`▸ <b>${escapeHtml(group.group.trim())}</b>`);
      for (const item of group.bullets) {
        lines.push(`  • ${escapeHtml(item.text)}`);
        for (const sub of item.sub ?? []) lines.push(`      ↳ ${escapeHtml(sub)}`);
      }
    }
  }

  const learnings = (draft.learnings ?? []).filter((l) => String(l?.text ?? '').trim());
  if (learnings.length) {
    lines.push('', `━━ <b>${escapeHtml(DAILY_SECTIONS.learnings)}</b>`);
    for (const item of learnings) {
      lines.push(`  • ${escapeHtml(item.text)}`);
      for (const sub of item.sub ?? []) lines.push(`      ↳ ${escapeHtml(sub)}`);
    }
  }

  const dropped = (draft.dropped ?? []).filter((d) => String(d ?? '').trim());
  if (dropped.length) {
    lines.push('', `⚠️ <b>분류 못 한 ${dropped.length}건</b> — '${escapeHtml(DAILY_SECTIONS.done)}' 아래 원문 그대로 넣습니다`);
    for (const text of dropped) lines.push(`  • ${escapeHtml(text)}`);
  }

  if (!doneGroups.length && !learnings.length && !dropped.length) {
    lines.push('', '(정리된 내용이 없습니다)');
  }

  return lines.join('\n');
}

/** `{ text, sub }` 목록을 불릿 줄로. 미리보기의 모든 섹션이 같은 모양을 쓴다. */
function previewItems(items, lines) {
  for (const item of items) {
    lines.push(`  • ${escapeHtml(item.text)}`);
    for (const sub of item.sub ?? []) lines.push(`      ↳ ${escapeHtml(sub)}`);
  }
}

/** 주기 회고(KLPT) 미리보기 */
export function renderPeriodPreview(draft, { title, sourceCount, note } = {}) {
  const lines = [`🧭 <b>${escapeHtml(title ?? draft.period)}</b>`];
  lines.push(`<i>회고 ${sourceCount ?? 0}개를 간추렸습니다</i>`);
  if (note) lines.push('', `⚠️ ${escapeHtml(note)}`);

  const review = (draft.tryReview ?? []).filter((item) => String(item?.text ?? '').trim());
  if (review.length) {
    const done = review.filter((item) => item.done).length;
    lines.push('', `━━ <b>${escapeHtml(PERIOD_SECTIONS.tryReview)}</b> (${done}/${review.length})`);
    for (const item of review) {
      lines.push(`  ${item.done ? '☑' : '☐'} ${escapeHtml(item.text)}`);
      if (String(item.note ?? '').trim()) lines.push(`      ↳ ${escapeHtml(item.note.trim())}`);
    }
  }

  for (const key of ['keep', 'problem', 'learned', 'try']) {
    const items = (draft[key] ?? []).filter((item) => String(item?.text ?? '').trim());
    if (!items.length) continue;
    lines.push('', `━━ <b>${escapeHtml(PERIOD_SECTIONS[key])}</b>`);
    previewItems(items, lines);
  }

  if (!review.length && !['keep', 'problem', 'learned', 'try'].some((k) => (draft[k] ?? []).length)) {
    lines.push('', '(간추린 내용이 없습니다)');
  }

  return lines.join('\n');
}

export function previewKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '✅ 저장', callback_data: `save:${token}` },
        { text: '🔄 다시 정리', callback_data: `redo:${token}` },
      ],
      [
        { text: '📄 원문', callback_data: `raw:${token}` },
        { text: '❌ 취소', callback_data: `cancel:${token}` },
      ],
    ],
  };
}

export function retryKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '🔁 저장 다시 시도', callback_data: `save:${token}` },
        { text: '❌ 취소', callback_data: `cancel:${token}` },
      ],
    ],
  };
}

/**
 * 원문 조각 목록.
 *
 * startIndex 는 날짜별로 나눠 보낼 때 번호를 이어 붙이기 위한 것이다. /drop 이
 * 이 번호를 그대로 받으므로, 날짜 그룹마다 1번부터 다시 세면 번호가 겹쳐버린다.
 */
export function renderFragments(fragments, { title = '📄 <b>원문 조각</b>', startIndex = 0 } = {}) {
  if (!fragments.length) return '쌓인 조각이 없습니다.';
  const lines = [title, ''];
  fragments.forEach((fragment, index) => {
    const time = new Date(fragment.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    lines.push(`<b>${startIndex + index + 1}.</b> <i>${escapeHtml(time)}</i>`);
    lines.push(escapeHtml(fragment.text));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/** 긴 조각을 한 줄로 줄여 보여준다. 무엇을 버렸는지 확인시키는 용도. */
export function excerpt(text, limit = 60) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/** /clear 확인 버튼. 되돌릴 수 없는 쪽이 왼쪽에 오지 않도록 취소를 먼저 둔다. */
export function clearKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '❌ 그대로 두기', callback_data: `clear_no:${token}` },
        { text: '🗑 전부 비우기', callback_data: `clear_yes:${token}` },
      ],
    ],
  };
}
