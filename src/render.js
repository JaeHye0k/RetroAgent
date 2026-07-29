import { SECTIONS } from './blocks.js';
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
    lines.push('', `━━ <b>${escapeHtml(SECTIONS.done.title)}</b>`);
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
    lines.push('', `━━ <b>${escapeHtml(SECTIONS.learnings.title)}</b>`);
    for (const item of learnings) {
      lines.push(`  • ${escapeHtml(item.text)}`);
      for (const sub of item.sub ?? []) lines.push(`      ↳ ${escapeHtml(sub)}`);
    }
  }

  const dropped = (draft.dropped ?? []).filter((d) => String(d ?? '').trim());
  if (dropped.length) {
    lines.push('', `⚠️ <b>분류 못 한 ${dropped.length}건</b> — '${escapeHtml(SECTIONS.done.title)}' 아래 원문 그대로 넣습니다`);
    for (const text of dropped) lines.push(`  • ${escapeHtml(text)}`);
  }

  if (!doneGroups.length && !learnings.length && !dropped.length) {
    lines.push('', '(정리된 내용이 없습니다)');
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

/** 원문 조각 목록 */
export function renderFragments(fragments, { title = '📄 <b>원문 조각</b>' } = {}) {
  if (!fragments.length) return '쌓인 조각이 없습니다.';
  const lines = [title, ''];
  fragments.forEach((fragment, index) => {
    const time = new Date(fragment.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    lines.push(`<b>${index + 1}.</b> <i>${escapeHtml(time)}</i>`);
    lines.push(escapeHtml(fragment.text));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
