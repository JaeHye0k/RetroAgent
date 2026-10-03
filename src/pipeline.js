import crypto from 'node:crypto';
import path from 'node:path';
import {
  bulletBlocks,
  doneBlocks,
  droppedBlocks,
  learningBlocks,
  tryBlocks,
  tryReviewBlocks,
} from './blocks.js';
import {
  addDays,
  coveragePlan,
  CYCLES,
  DAILY,
  DAILY_SECTIONS,
  duePeriods,
  PERIOD_SECTIONS,
  periodEndingOn,
} from './cycles.js';
import { pageUrl, sectionText } from './notion.js';
import {
  clearKeyboard,
  escapeHtml,
  excerpt,
  previewKeyboard,
  renderFragments,
  renderPeriodPreview,
  renderPreview,
  retryKeyboard,
} from './render.js';
import { dueGroups, groupByRetroDate, humanDate, retroDateOf } from './schedule.js';
import { JsonStore } from './store.js';

/** digest-state 에 보관할 처리 완료 날짜 개수 상한 */
const DONE_DATES_LIMIT = 60;

/** 버린 조각 원문이 남는 곳 — 회신에 그대로 적어 되찾을 길을 알려준다. */
const DISCARD_NOTE = '원문은 <code>data/archive/discarded.jsonl</code> 에 남아 있습니다.';

const DROP_HINT =
  '🗑 <b>/drop 2</b> 로 조각 하나를, <b>/clear</b> 로 큐 전체를 비웁니다.\n<code>/drop 2 5</code> · <code>/drop 2-4</code> 처럼 여러 개도 됩니다.';

/** period-state 에 보관할 처리 완료 주기 개수 상한 */
const DONE_PERIODS_LIMIT = 60;

/** 일간 저장 단계 — 섹션 하나가 한 단계다. */
function dailySteps(draft) {
  return [
    {
      key: 'done',
      title: DAILY_SECTIONS.done,
      blocks: [...doneBlocks(draft.done), ...droppedBlocks(draft.dropped)],
    },
    { key: 'learnings', title: DAILY_SECTIONS.learnings, blocks: learningBlocks(draft.learnings) },
  ];
}

/** 주기 저장 단계 — KLPT 다섯 섹션을 템플릿 순서대로. */
function periodSteps(draft) {
  return [
    { key: 'tryReview', title: PERIOD_SECTIONS.tryReview, blocks: tryReviewBlocks(draft.tryReview) },
    { key: 'keep', title: PERIOD_SECTIONS.keep, blocks: bulletBlocks(draft.keep) },
    { key: 'problem', title: PERIOD_SECTIONS.problem, blocks: bulletBlocks(draft.problem) },
    { key: 'learned', title: PERIOD_SECTIONS.learned, blocks: bulletBlocks(draft.learned) },
    { key: 'try', title: PERIOD_SECTIONS.try, blocks: tryBlocks(draft.try) },
  ];
}

/**
 * 정리 → 미리보기 → 승인 → 저장 상태 머신.
 *
 * 일간(조각글 → 회고)과 주기(이미 쓴 회고들 → 더 높은 층위의 회고)가 같은
 * 미리보기·승인 흐름을 쓴다. pending.kind 로 갈린다.
 *
 * 불변 조건: 노션 저장이 성공하기 전까지 큐에서 조각을 빼지 않는다.
 * 어느 단계에서 실패하든 다시 /now 를 누르면 그대로 재시도할 수 있어야 한다.
 */
export class Pipeline {
  constructor({ config, telegram, notion, composer, queue, logger = console }) {
    this.config = config;
    this.telegram = telegram;
    this.notion = notion;
    this.composer = composer;
    this.queue = queue;
    this.log = logger;

    this.chatId = config.telegram.chatId;
    this.pending = new JsonStore(path.join(config.dataDir, 'pending.json'), null);
    this.digestState = new JsonStore(path.join(config.dataDir, 'digest-state.json'), { doneDates: [] });
    this.periodState = new JsonStore(path.join(config.dataDir, 'period-state.json'), {
      seeded: false,
      donePeriods: [],
    });
    this.lastWrite = new JsonStore(path.join(config.dataDir, 'last-write.json'), null);
    this.busy = false;
    // /clear 확인 대기. 일부러 메모리에만 둔다 — 재시작하면 확인이 만료되는 편이,
    // 언제 눌렀는지 모를 버튼이 살아남아 큐를 비우는 것보다 낫다.
    this.pendingClear = null;
  }

  say(text, options) {
    return this.telegram.sendLong(this.chatId, text, options);
  }

  now() {
    return new Date();
  }

  currentRetroDate() {
    return retroDateOf(this.now(), this.config.cutoffHour);
  }

  /** 큐를 조각의 ts 기준 회고 날짜별로 묶는다. 오래된 날짜부터. */
  async queueGroups() {
    const fragments = await this.queue.readAll();
    return groupByRetroDate(fragments, this.config.cutoffHour, this.currentRetroDate());
  }

  /** 이 날짜는 자동 발송을 마쳤다고 기록한다. 취소해도 스케줄러가 다시 들이밀지 않는다. */
  async markDone(retroDate) {
    const { doneDates = [] } = await this.digestState.read();
    const next = [...new Set([...doneDates, retroDate])].sort().slice(-DONE_DATES_LIMIT);
    await this.digestState.write({ doneDates: next });
  }

  /**
   * 30초마다 호출된다. 임계 시각이 지난 날짜 중 가장 오래 밀린 것 하나를 정리한다.
   * 하루에 하나씩만 다루므로, 며칠 밀려 있으면 승인할 때마다 다음 날짜가 이어서 나온다.
   */
  async maybeRunDigest() {
    if (this.busy) return false;
    // 승인 대기 중에는 아무것도 하지 않는다. 승인이 끝나면 다음 틱이 이어받는다.
    if (await this.pending.read()) return false;

    const { doneDates = [] } = await this.digestState.read();
    const due = dueGroups({
      now: this.now(),
      groups: await this.queueGroups(),
      digestTime: this.config.digestTime,
      doneDates,
    });
    if (!due.length) return false;

    await this.runDigestFor(due[0], { trigger: 'schedule', remaining: due.length - 1 });
    return true;
  }

  /**
   * 스케줄러가 30초마다 부른다.
   *
   * 일간을 먼저 돌린다. 주기 회고는 노션에 저장된 일간 페이지를 읽으므로,
   * 그 기간 마지막 날의 일간이 먼저 저장돼 있어야 재료가 온전하다.
   */
  async tick() {
    if (await this.maybeRunDigest()) return true;
    return this.maybePeriodicDigest();
  }

  /** 이 주기는 이미 보여줬다고 기록한다. */
  async markPeriodDone(key) {
    const { donePeriods = [] } = await this.periodState.read();
    const next = [...new Set([...donePeriods, key])].slice(-DONE_PERIODS_LIMIT);
    await this.periodState.write({ donePeriods: next });
  }

  /**
   * 밀린 주기 목록. 첫 실행이면 과거를 전부 처리한 것으로 표시하고 넘어간다.
   *
   * 이 씨 뿌리기가 없으면, 설치하자마자 지난 45일치 주기 회고가 한꺼번에
   * 쏟아진다. 에이전트를 켜기 전의 기간까지 회고해 달라고 한 적은 없다.
   */
  async pendingPeriods() {
    const state = await this.periodState.read();
    const args = {
      now: this.now(),
      periodicTime: this.config.periodicTime,
      cutoffHour: this.config.cutoffHour,
    };

    if (!state.seeded) {
      const past = duePeriods({ ...args, donePeriods: [] });
      await this.periodState.write({
        seeded: true,
        donePeriods: past.map((period) => period.key).slice(-DONE_PERIODS_LIMIT),
      });
      this.log.log?.(`[pipeline] 주기 회고 시작점을 잡았습니다 — 지난 ${past.length}개는 건너뜁니다.`);
      return [];
    }

    return duePeriods({ ...args, donePeriods: state.donePeriods ?? [] });
  }

  /** 정리할 때가 된 주기 하나를 처리한다. 일간과 같은 게이트를 쓴다. */
  async maybePeriodicDigest() {
    if (this.busy) return false;
    if (await this.pending.read()) return false;

    const due = await this.pendingPeriods();
    if (!due.length) return false;

    await this.runPeriodFor(due[0], { trigger: 'schedule', remaining: due.length - 1 });
    return true;
  }

  /**
   * /period — 가장 최근에 끝난 주기를 지금 정리한다.
   * 발송 시각과 처리 이력을 무시한다. /now 의 주기 버전이다.
   */
  async runPeriod() {
    if (this.busy) {
      await this.say('⏳ 이미 정리하고 있습니다. 잠시만요.');
      return;
    }
    if (await this.pending.read()) {
      await this.say(
        '⚠️ 아직 승인하지 않은 정리가 있습니다. 위 미리보기에서 <b>저장</b> 또는 <b>취소</b>를 먼저 눌러주세요.',
      );
      return;
    }

    // 오늘부터 거슬러 올라가며 가장 가까운 주기 끝을 찾는다.
    const today = this.currentRetroDate();
    let period = null;
    for (let back = 0; back < 400 && !period; back += 1) {
      period = periodEndingOn(addDays(today, -back));
    }
    if (!period) {
      await this.say('정리할 주기를 찾지 못했습니다.');
      return;
    }

    await this.runPeriodFor(period, { trigger: 'manual' });
  }

  /**
   * 한 주기 몫을 간추려 미리보기를 보낸다.
   *
   * 재료는 조각글 큐가 아니라 **그 기간에 이미 쓴 회고 페이지들**이다.
   * 굵은 주기 페이지가 있으면 그것을 먼저 쓰고, 빈 구간만 잘게 메운다.
   */
  async runPeriodFor(period, { trigger, remaining = 0 }) {
    const { cycle, start, end, title, key } = period;
    const cycleName = CYCLES[cycle].name;

    this.busy = true;
    try {
      const backlog = remaining
        ? `\n(다른 주기 ${remaining}건이 더 밀려 있습니다. 이 건을 처리하면 이어서 보냅니다.)`
        : '';
      await this.say(`🧭 <b>${escapeHtml(title)}</b> 를 간추리고 있습니다…${backlog}`);

      const pages = await this.notion.listPagesInRange({ start, end });
      const chosen = coveragePlan({ cycle, range: { start, end }, pages });

      if (!chosen.length) {
        await this.say(
          `📭 ${escapeHtml(title)} — 그 기간(${start} ~ ${end})에 쌓인 회고가 없습니다. 만들지 않았습니다.`,
        );
        if (trigger === 'schedule') await this.markPeriodDone(key);
        return;
      }

      const sources = [];
      for (const page of chosen) {
        sources.push({ title: page.title || page.date, text: await this.notion.pageText(page.id) });
      }

      // 지난 같은 주기 회고의 Try — 이것이 '지난 주기 Try 점검' 의 재료다.
      let previousTry = '';
      try {
        const previous = await this.notion.findPreviousPage(cycle, end);
        if (previous) {
          previousTry = sectionText(await this.notion.pageText(previous.id), PERIOD_SECTIONS.try);
        }
      } catch (error) {
        this.log.error('[pipeline] 지난 주기 Try 조회 실패(무시):', error.message);
      }

      const { draft, ok, reason } = await this.composer.composePeriod({
        title,
        cycleName,
        range: { start, end },
        sources,
        previousTry,
      });

      // 일간과 달리 폴백이 없다. 재료는 이미 노션에 있으니 빈 페이지를 만들지 않는다.
      if (!ok) {
        await this.say(`❌ ${escapeHtml(reason)}\n\n재료는 노션에 그대로 있습니다. /period 로 다시 시도해주세요.`);
        if (trigger === 'schedule') await this.markPeriodDone(key);
        return;
      }

      const token = crypto.randomUUID().slice(0, 8);
      const note = await this.unsettledNote({ start, end });
      const text = renderPeriodPreview(draft, { title, sourceCount: sources.length, note });
      const message = await this.say(text, { reply_markup: previewKeyboard(token) });

      await this.pending.write({
        kind: 'period',
        token,
        cycle,
        title,
        range: { start, end },
        // 주기 회고 페이지의 '날짜' 속성에는 기간의 마지막 날이 들어간다.
        retroDate: end,
        draft,
        fragments: [],
        sourceCount: sources.length,
        previewMessageId: message?.message_id ?? null,
        composedOk: true,
      });

      await this.markPeriodDone(key);
    } catch (error) {
      this.log.error('[pipeline] 주기 정리 실패:', error);
      await this.say(
        `❌ ${escapeHtml(title)} 를 간추리지 못했습니다.\n<code>${escapeHtml(error.message)}</code>\n\n/period 로 다시 시도해주세요.`,
      );
      if (trigger === 'schedule') await this.markPeriodDone(key);
    } finally {
      this.busy = false;
    }
  }

  /** 기간 안의 날짜가 아직 큐에 남아 있으면 알려준다. 막지는 않는다. */
  async unsettledNote({ start, end }) {
    const groups = await this.queueGroups();
    const stuck = groups.filter((group) => group.retroDate >= start && group.retroDate <= end);
    if (!stuck.length) return undefined;

    const total = stuck.reduce((sum, group) => sum + group.fragments.length, 0);
    return `이 기간의 조각 ${total}개가 아직 큐에 있습니다 (${stuck.map((g) => g.retroDate).join(', ')}). 재료에 반영되지 않았습니다.`;
  }

  /**
   * /now — 큐에 남은 가장 오래된 날짜를 정리한다.
   * 임계 시각과 처리 이력을 무시한다. 사람이 직접 누른 것이니 지금 하겠다는 뜻이다.
   */
  async runDigest() {
    if (this.busy) {
      await this.say('⏳ 이미 정리하고 있습니다. 잠시만요.');
      return;
    }

    if (await this.pending.read()) {
      await this.say(
        '⚠️ 아직 승인하지 않은 정리가 있습니다. 위 미리보기에서 <b>저장</b> 또는 <b>취소</b>를 먼저 눌러주세요.',
      );
      return;
    }

    const groups = await this.queueGroups();
    if (!groups.length) {
      await this.say('📭 쌓인 조각이 없습니다.');
      return;
    }

    await this.runDigestFor(groups[0], { trigger: 'manual', remaining: groups.length - 1 });
  }

  /**
   * 한 회고 날짜 몫을 정리해 미리보기를 보낸다.
   * 스냅샷을 pending 에 넣으므로, 이후 들어오는 조각과 다른 날짜 몫은 큐에 남는다.
   */
  async runDigestFor({ retroDate, fragments }, { trigger, remaining = 0 }) {
    this.busy = true;
    try {
      const backlog = remaining ? `\n(다른 날짜 ${remaining}일이 더 밀려 있습니다. 이 건을 처리하면 이어서 보냅니다.)` : '';
      await this.say(`🧵 ${humanDate(retroDate)} 조각 ${fragments.length}개를 정리하고 있습니다…${backlog}`);
      await this.composeAndSendPreview({ fragments, retroDate });
    } catch (error) {
      this.log.error('[pipeline] 정리 실패:', error);
      await this.say(`❌ 정리 중 오류가 났습니다.\n<code>${escapeHtml(error.message)}</code>\n\n조각은 그대로 큐에 있습니다. /now 로 다시 시도해주세요.`);
      // 실패해도 표시해 둔다. 스케줄러가 30초마다 같은 실패를 반복하면 안 된다.
      if (trigger === 'schedule') await this.markDone(retroDate);
    } finally {
      this.busy = false;
    }
  }

  async composeAndSendPreview({ fragments, retroDate, extraInstruction }) {
    // 이미 페이지에 적힌 내용을 넘겨 중복 작성을 막는다. 실패해도 정리는 계속한다.
    let existingText = '';
    try {
      const page = await this.notion.findDailyPage(retroDate);
      if (page) existingText = await this.notion.pageText(page.id);
    } catch (error) {
      this.log.error('[pipeline] 기존 페이지 조회 실패(무시):', error.message);
    }

    const { draft, ok, reason } = await this.composer.compose({
      fragments,
      dateString: retroDate,
      existingText,
      extraInstruction,
    });

    const token = crypto.randomUUID().slice(0, 8);
    const text = renderPreview(draft, { fragmentCount: fragments.length, note: ok ? undefined : reason });
    const message = await this.say(text, { reply_markup: previewKeyboard(token) });

    await this.pending.write({
      token,
      retroDate,
      draft,
      fragments,
      previewMessageId: message?.message_id ?? null,
      composedOk: ok,
    });

    // 이 회고 날짜의 정리는 이미 보여줬다. 취소하더라도 스케줄러가 다시 들이밀지 않는다.
    await this.markDone(retroDate);
  }

  async handleCallback(query) {
    const [action, token] = String(query.data ?? '').split(':');

    // /clear 확인은 미리보기와 다른 상태를 쓴다. pending 검사에 걸리기 전에 갈라낸다.
    if (action === 'clear_yes' || action === 'clear_no') {
      return this.handleClearCallback(action, token, query);
    }

    const pending = await this.pending.read();

    if (!pending || pending.token !== token) {
      await this.telegram.answerCallbackQuery(query.id, { text: '만료된 미리보기입니다.', show_alert: true });
      if (query.message) await this.telegram.clearKeyboard(this.chatId, query.message.message_id);
      return;
    }

    switch (action) {
      case 'save':
        return this.save(query, pending);
      case 'redo':
        return this.redo(query, pending);
      case 'raw':
        return this.showRaw(query, pending);
      case 'cancel':
        return this.cancel(query, pending);
      default:
        await this.telegram.answerCallbackQuery(query.id, { text: '알 수 없는 동작입니다.' });
    }
  }

  async save(query, pending) {
    if (this.busy) {
      await this.telegram.answerCallbackQuery(query.id, { text: '다른 작업이 진행 중입니다.', show_alert: true });
      return;
    }

    this.busy = true;
    await this.telegram.answerCallbackQuery(query.id, { text: '노션에 저장 중…' });
    await this.telegram.clearKeyboard(this.chatId, query.message.message_id);

    const isPeriod = pending.kind === 'period';

    try {
      const { draft, retroDate, fragments } = pending;
      const cycle = pending.cycle ?? DAILY;
      const { page, created } = await this.notion.findOrCreatePage(retroDate, cycle);

      // 섹션 단위로 진행 상황을 남긴다. 두 번째 섹션에서 실패해 재시도할 때
      // 첫 번째 섹션이 다시 삽입되면 페이지에 같은 내용이 두 번 들어간다.
      const steps = isPeriod ? periodSteps(draft) : dailySteps(draft);
      const progress =
        pending.progress ?? { blockIds: [], ...Object.fromEntries(steps.map((s) => [s.key, false])) };

      for (const step of steps) {
        if (progress[step.key]) continue;
        // 각 호출이 페이지 블록을 다시 읽는다. 앞선 삽입이 다음 기준점을 흔들기 때문이다.
        progress.blockIds.push(
          ...(await this.notion.appendToSection(page.id, step.title, step.blocks, { cycle })),
        );
        progress[step.key] = true;
        await this.pending.write({ ...pending, progress });
      }

      const blockIds = progress.blockIds;
      await this.lastWrite.write({ pageId: page.id, url: pageUrl(page), blockIds, retroDate, fragments });
      // 주기 회고에는 조각글이 없다. 큐를 건드릴 일이 없다.
      if (!isPeriod) await this.queue.remove(fragments.map((f) => f.id), { retroDate });
      await this.pending.clear();

      const label = isPeriod ? pending.title : `${humanDate(retroDate)} 일간 회고`;
      const lines = [
        `✅ <a href="${pageUrl(page)}">${escapeHtml(label)}</a>에 저장했습니다.`,
        `${created ? '페이지를 새로 만들었습니다.' : '기존 페이지에 이어 붙였습니다.'} 블록 ${blockIds.length}개 추가.`,
      ];

      if (!isPeriod) {
        // 남은 조각을 날짜별로 알려준다. 밀린 날짜가 있으면 그게 다음 차례다.
        const rest = await this.queueGroups();
        if (rest.length) {
          lines.push(
            '',
            `📥 큐에 남은 조각: ${rest.map((g) => `${humanDate(g.retroDate)} ${g.fragments.length}개`).join(', ')}`,
          );
        }
      }
      lines.push('\n되돌리려면 /undo');
      await this.say(lines.join('\n'));
    } catch (error) {
      this.log.error('[pipeline] 저장 실패:', error);
      await this.say(
        [
          '❌ 노션 저장에 실패했습니다.',
          `<code>${escapeHtml(error.message)}</code>`,
          '',
          isPeriod
            ? '재료는 노션에 그대로 있습니다. 아래 버튼으로 다시 시도할 수 있습니다.'
            : '조각은 큐에 그대로 있습니다. 아래 버튼으로 다시 시도할 수 있습니다.',
        ].join('\n'),
        { reply_markup: retryKeyboard(pending.token) },
      );
    } finally {
      this.busy = false;
    }
  }

  async redo(query, pending) {
    if (this.busy) {
      await this.telegram.answerCallbackQuery(query.id, { text: '다른 작업이 진행 중입니다.', show_alert: true });
      return;
    }

    this.busy = true;
    await this.telegram.answerCallbackQuery(query.id, { text: '다시 정리 중…' });
    await this.telegram.clearKeyboard(this.chatId, query.message.message_id);

    try {
      await this.pending.clear();
      await this.composeAndSendPreview({
        fragments: pending.fragments,
        retroDate: pending.retroDate,
        extraInstruction:
          '직전 정리 결과가 마음에 들지 않는다. 항목을 묶는 단위와 사실·배움을 나누는 기준을 다시 잡아 새로 정리하라.',
      });
    } catch (error) {
      this.log.error('[pipeline] 재정리 실패:', error);
      await this.say(`❌ 다시 정리하지 못했습니다.\n<code>${escapeHtml(error.message)}</code>\n\n/now 로 재시도해주세요.`);
    } finally {
      this.busy = false;
    }
  }

  async showRaw(query, pending) {
    await this.telegram.answerCallbackQuery(query.id);
    await this.say(renderFragments(pending.fragments));
  }

  async cancel(query, pending) {
    await this.telegram.answerCallbackQuery(query.id, { text: '취소했습니다.' });
    await this.telegram.clearKeyboard(this.chatId, query.message.message_id);
    await this.pending.clear();

    const lines = [`🚫 저장하지 않았습니다. 조각 ${pending.fragments.length}개는 큐에 그대로 있습니다.`];
    // 저장이 중간에 실패한 뒤 취소했다면 일부 블록은 이미 노션에 들어가 있다.
    const written = pending.progress?.blockIds?.length ?? 0;
    if (written) {
      lines.push(
        '',
        `⚠️ 직전 저장 시도에서 블록 ${written}개가 이미 노션에 들어갔습니다. 노션에서 직접 지워주세요.`,
      );
    }
    await this.say(lines.join('\n'));
  }

  async showQueue() {
    const groups = await this.queueGroups();
    if (!groups.length) {
      await this.say('📭 쌓인 조각이 없습니다.');
      return;
    }

    // 날짜별로 나눠 보여준다. 어느 날짜가 밀려 있는지가 한눈에 보여야 한다.
    // 번호는 날짜를 가로질러 이어 붙인다 — /drop 이 이 번호를 그대로 받는다.
    let startIndex = 0;
    for (const [index, { retroDate, fragments }] of groups.entries()) {
      const body = renderFragments(fragments, {
        title: `📥 <b>${humanDate(retroDate)}</b> — 조각 ${fragments.length}개`,
        startIndex,
      });
      const isLast = index === groups.length - 1;
      await this.say(isLast ? `${body}\n\n${DROP_HINT}` : body);
      startIndex += fragments.length;
    }
  }

  /**
   * 큐를 손대도 되는 때인가.
   * 정리 중이거나 승인 대기 중에 조각을 빼면, 이미 스냅샷을 뜬 pending 은
   * 사라진 조각을 그대로 노션에 적어버린다. 그 창을 아예 막는다.
   */
  async guardQueueEdit() {
    if (this.busy) {
      await this.say('⏳ 지금 정리하고 있습니다. 끝나면 다시 시도해주세요.');
      return false;
    }
    if (await this.pending.read()) {
      await this.say(
        '⚠️ 승인하지 않은 정리가 있습니다. 위 미리보기에서 <b>저장</b> 또는 <b>취소</b>를 먼저 눌러주세요.',
      );
      return false;
    }
    return true;
  }

  /** /queue 에 보이는 순서 그대로 펼친 목록. /drop 의 번호가 여기서 나온다. */
  async queueList() {
    return (await this.queueGroups()).flatMap((group) => group.fragments);
  }

  /**
   * /drop 2 5 — /queue 번호로 특정 조각만 뺀다.
   *
   * 확인 버튼을 두지 않는다. 대상이 좁고 원문이 아카이브에 남으며, 무엇을
   * 뺐는지 회신에 그대로 보여주므로 잘못 눌러도 바로 알아챌 수 있다.
   */
  async dropFragments(numbers) {
    if (!(await this.guardQueueEdit())) return;

    const fragments = await this.queueList();
    if (!fragments.length) {
      await this.say('📭 쌓인 조각이 없습니다.');
      return;
    }

    const picked = [];
    const missing = [];
    for (const number of numbers) {
      const fragment = fragments[number - 1];
      if (fragment) picked.push({ number, fragment });
      else missing.push(number);
    }

    if (!picked.length) {
      await this.say(
        `❌ ${missing.join(', ')}번 조각이 없습니다. 지금 큐에는 1~${fragments.length}번이 있습니다.\n/queue 로 번호를 확인해주세요.`,
      );
      return;
    }

    const removed = await this.queue.discard(picked.map((p) => p.fragment.id));

    const lines = [`🗑 조각 ${removed.length}개를 큐에서 뺐습니다.`, ''];
    for (const { number, fragment } of picked) {
      lines.push(`<b>${number}.</b> ${escapeHtml(excerpt(fragment.text))}`);
    }
    if (missing.length) lines.push('', `⚠️ ${missing.join(', ')}번은 없어서 건너뛰었습니다.`);
    lines.push('', `📥 큐에 남은 조각 ${fragments.length - removed.length}개`, DISCARD_NOTE);
    await this.say(lines.join('\n'));
  }

  /** /clear — 큐 전체를 비운다. 되돌릴 버튼이 없는 일이라 확인을 한 번 받는다. */
  async confirmClear() {
    if (!(await this.guardQueueEdit())) return;

    const fragments = await this.queue.readAll();
    if (!fragments.length) {
      await this.say('📭 쌓인 조각이 없습니다.');
      return;
    }

    // 확인 시점에 큐를 다시 읽지 않고 이 스냅샷만 지운다. 버튼을 누르기까지
    // 사이에 들어온 새 조각까지 쓸어가면, 본 적 없는 것을 지우는 셈이 된다.
    const token = crypto.randomUUID().slice(0, 8);
    this.pendingClear = { token, ids: fragments.map((f) => f.id) };

    await this.say(
      [
        `🗑 큐에 쌓인 조각 <b>${fragments.length}개</b>를 전부 비울까요?`,
        '',
        `${DISCARD_NOTE} 되찾을 수는 있지만 큐에서는 사라집니다.`,
      ].join('\n'),
      { reply_markup: clearKeyboard(token) },
    );
  }

  async handleClearCallback(action, token, query) {
    if (!this.pendingClear || this.pendingClear.token !== token) {
      await this.telegram.answerCallbackQuery(query.id, {
        text: '만료된 확인입니다. /clear 를 다시 보내주세요.',
        show_alert: true,
      });
      if (query.message) await this.telegram.clearKeyboard(this.chatId, query.message.message_id);
      return;
    }

    const { ids } = this.pendingClear;
    this.pendingClear = null;
    if (query.message) await this.telegram.clearKeyboard(this.chatId, query.message.message_id);

    if (action === 'clear_no') {
      await this.telegram.answerCallbackQuery(query.id, { text: '그대로 뒀습니다.' });
      await this.say(`🚫 큐를 비우지 않았습니다. 조각 ${ids.length}개 그대로입니다.`);
      return;
    }

    // 확인을 누르기까지 사이에 자동 정리가 끼어들었을 수 있다.
    if (this.busy || (await this.pending.read())) {
      await this.telegram.answerCallbackQuery(query.id, { text: '지금은 비울 수 없습니다.', show_alert: true });
      await this.say('⚠️ 그새 정리가 시작됐습니다. 그 건을 처리한 뒤 /clear 를 다시 보내주세요.');
      return;
    }

    await this.telegram.answerCallbackQuery(query.id, { text: '큐를 비웠습니다.' });
    const removed = await this.queue.discard(ids);
    const left = await this.queue.size();

    const lines = [`🗑 조각 ${removed.length}개를 큐에서 비웠습니다.`, DISCARD_NOTE];
    if (left) lines.push('', `📥 확인하는 사이에 들어온 조각 ${left}개는 큐에 남겨뒀습니다.`);
    await this.say(lines.join('\n'));
  }

  async undo() {
    const record = await this.lastWrite.read();
    if (!record) {
      await this.say('되돌릴 저장 기록이 없습니다.');
      return;
    }

    await this.say('↩️ 되돌리는 중…');
    try {
      const failed = await this.notion.deleteBlocks(record.blockIds);
      const restored = await this.queue.restore(record.fragments ?? []);
      await this.lastWrite.clear();

      const lines = [
        `↩️ 노션 블록 ${record.blockIds.length - failed.length}개를 삭제하고 조각 ${restored}개를 큐에 되돌렸습니다.`,
      ];
      if (failed.length) lines.push(`⚠️ ${failed.length}개는 삭제하지 못했습니다. 노션에서 직접 확인해주세요.`);
      await this.say(lines.join('\n'));
    } catch (error) {
      this.log.error('[pipeline] undo 실패:', error);
      await this.say(`❌ 되돌리지 못했습니다.\n<code>${escapeHtml(error.message)}</code>`);
    }
  }
}
