import { heading2, headingText } from './blocks.js';
import { CYCLES, cycleByName, DAILY, rangeOf, titleFor } from './cycles.js';
import { loadTemplate, scaffoldFor, sectionBlocks } from './template.js';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 회고 DB 의 속성 이름 */
export const PROPS = { title: '이름', date: '날짜', cycle: '주기' };
export const DAILY_CYCLE = CYCLES[DAILY].name;

/** 노션 페이지 속성에서 제목 문자열을 뽑는다. */
function titleOf(page) {
  return (page?.properties?.[PROPS.title]?.title ?? [])
    .map((rt) => rt.plain_text ?? rt.text?.content ?? '')
    .join('');
}

export class NotionError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 노션 요청 하나의 응답 대기 한도 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class Notion {
  constructor({ token, dbId, fetchImpl = fetch, maxRetries = 3, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.token = token;
    this.dbId = dbId;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(`${API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            'notion-version': NOTION_VERSION,
            'content-type': 'application/json',
          },
          // 잠자기에서 깨어날 때 죽은 소켓에 매달리는 것을 막는다.
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // 타임아웃·네트워크 오류는 재시도 대상이다.
        const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
        lastError = new NotionError(
          timedOut ? `${this.timeoutMs}ms 안에 응답이 없어 끊었습니다` : error.message,
          { path, code: timedOut ? 'timeout' : 'network_error' },
        );
        if (attempt === this.maxRetries) throw lastError;
        await sleep(2 ** attempt * 1000);
        continue;
      }

      if (response.ok) return response.json();

      const payload = await response.json().catch(() => ({}));
      lastError = new NotionError(payload.message ?? `HTTP ${response.status}`, {
        status: response.status,
        code: payload.code,
        path,
      });

      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable || attempt === this.maxRetries) throw lastError;

      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
    }

    throw lastError;
  }

  /** 연결 확인용 — DB 를 읽을 수 있는지 */
  retrieveDatabase() {
    return this.request('GET', `/databases/${this.dbId}`);
  }

  /**
   * 그 날짜에 끝나는 해당 주기의 회고 페이지를 찾는다. 없으면 null.
   *
   * '날짜' 속성에는 언제나 기간의 **마지막 날** 하나만 넣는다. 주간·월간도
   * 마찬가지다. 기간의 시작은 주기만 알면 되살릴 수 있으므로(cycles.rangeOf),
   * 날짜 범위를 쓰는 것보다 조회가 단순하고 확실하다.
   */
  async findPage(dateString, cycle = DAILY) {
    const result = await this.request('POST', `/databases/${this.dbId}/query`, {
      page_size: 5,
      filter: {
        and: [
          { property: PROPS.date, date: { equals: dateString } },
          { property: PROPS.cycle, select: { equals: CYCLES[cycle].name } },
        ],
      },
    });
    return result.results?.[0] ?? null;
  }

  async createPage(dateString, cycle = DAILY) {
    return this.request('POST', '/pages', {
      parent: { database_id: this.dbId },
      properties: {
        [PROPS.title]: {
          title: [{ type: 'text', text: { content: titleFor(cycle, rangeOf(cycle, dateString)) } }],
        },
        [PROPS.date]: { date: { start: dateString } },
        // 노션 select 는 없는 이름을 쓰면 옵션을 자동으로 만들어준다.
        [PROPS.cycle]: { select: { name: CYCLES[cycle].name } },
      },
      children: await scaffoldFor(cycle),
    });
  }

  async findOrCreatePage(dateString, cycle = DAILY) {
    const existing = await this.findPage(dateString, cycle);
    if (existing) return { page: existing, created: false };
    return { page: await this.createPage(dateString, cycle), created: true };
  }

  findDailyPage(dateString) {
    return this.findPage(dateString, DAILY);
  }

  findOrCreateDailyPage(dateString) {
    return this.findOrCreatePage(dateString, DAILY);
  }

  /**
   * 기간 안에 있는 회고 페이지를 전부 가져온다. 주기 회고의 재료를 모으는 데 쓴다.
   * 주기를 알아볼 수 없는 페이지는 건너뛴다 — 손으로 만든 페이지가 섞여 있을 수 있다.
   */
  async listPagesInRange({ start, end }) {
    const pages = [];
    let cursor;

    do {
      const result = await this.request('POST', `/databases/${this.dbId}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
        filter: {
          and: [
            { property: PROPS.date, date: { on_or_after: start } },
            { property: PROPS.date, date: { on_or_before: end } },
          ],
        },
        sorts: [{ property: PROPS.date, direction: 'ascending' }],
      });

      for (const page of result.results ?? []) {
        const date = page.properties?.[PROPS.date]?.date?.start;
        const cycle = cycleByName(page.properties?.[PROPS.cycle]?.select?.name);
        if (date && cycle) pages.push({ id: page.id, url: pageUrl(page), date, cycle, title: titleOf(page) });
      }

      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    return pages;
  }

  /** 같은 주기의 직전 회고 페이지. '지난 주기 Try 점검' 이 여기서 나온다. */
  async findPreviousPage(cycle, beforeDate) {
    const result = await this.request('POST', `/databases/${this.dbId}/query`, {
      page_size: 1,
      filter: {
        and: [
          { property: PROPS.cycle, select: { equals: CYCLES[cycle].name } },
          { property: PROPS.date, date: { before: beforeDate } },
        ],
      },
      sorts: [{ property: PROPS.date, direction: 'descending' }],
    });
    return result.results?.[0] ?? null;
  }

  async listChildren(blockId) {
    const blocks = [];
    let cursor;
    do {
      const query = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
      const result = await this.request('GET', `/blocks/${blockId}/children${query}`);
      blocks.push(...(result.results ?? []));
      cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }

  /** @returns 생성된 최상위 블록들의 id */
  async appendChildren(pageId, children, after) {
    if (!children.length) return [];
    const result = await this.request('PATCH', `/blocks/${pageId}/children`, {
      children,
      ...(after ? { after } : {}),
    });
    return (result.results ?? []).map((block) => block.id);
  }

  /**
   * 지정한 섹션 헤딩 아래, 그 섹션의 마지막 위치에 블록을 끼워넣는다.
   * 섹션 헤딩이 없으면 페이지 끝에 헤딩과 함께 추가한다.
   */
  async appendToSection(pageId, sectionTitle, children, { topLevelBlocks, cycle = DAILY } = {}) {
    if (!children.length) return [];

    const blocks = topLevelBlocks ?? (await this.listChildren(pageId));
    const headingIndex = blocks.findIndex((block) => headingText(block) === sectionTitle);

    if (headingIndex === -1) {
      // 섹션이 통째로 없는 페이지다. 템플릿에서 헤딩과 가이드를 가져와 함께 만든다.
      const preamble =
        sectionBlocks(await loadTemplate(cycle), sectionTitle) ?? [heading2(sectionTitle, 'default')];
      return this.appendChildren(pageId, [...preamble, ...children]);
    }

    // 섹션의 끝 = 다음 divider 또는 다음 heading_2 직전
    let anchorIndex = headingIndex;
    for (let i = headingIndex + 1; i < blocks.length; i += 1) {
      if (blocks[i].type === 'divider' || blocks[i].type === 'heading_2') break;
      anchorIndex = i;
    }

    return this.appendChildren(pageId, children, blocks[anchorIndex].id);
  }

  /** @returns 삭제하지 못한 블록 id 목록 */
  async deleteBlocks(blockIds) {
    const failed = [];
    for (const id of blockIds) {
      try {
        await this.request('DELETE', `/blocks/${id}`);
      } catch (error) {
        // 이미 지워진 블록은 성공으로 친다.
        if (error.status !== 404) failed.push(id);
      }
    }
    return failed;
  }

  /**
   * 페이지에 이미 적혀 있는 내용을 평문으로 뽑는다.
   * 정리할 때 중복 작성을 피하도록 LLM 에 넘기는 컨텍스트다.
   */
  async pageText(pageId) {
    const blocks = await this.listChildren(pageId);
    return blocks
      .map((block) => {
        const body = block[block.type];
        const rich = body?.rich_text;
        if (!Array.isArray(rich)) return block.type === 'divider' ? '---' : '';
        const text = rich.map((rt) => rt.plain_text ?? rt.text?.content ?? '').join('');
        if (!text) return '';
        if (block.type === 'heading_2') return `## ${text}`;
        if (block.type === 'bulleted_list_item') return `- ${text}`;
        // 체크 상태까지 적는다. 다음 주기 회고가 Try 의 실행 여부를 여기서 읽는다.
        if (block.type === 'to_do') return `- [${body.checked ? 'x' : ' '}] ${text}`;
        if (block.type === 'quote') return `> ${text}`;
        return text;
      })
      .filter(Boolean)
      .join('\n');
  }
}

/**
 * pageText 결과에서 한 섹션만 잘라낸다.
 * '## 제목' 부터 다음 '## ' 직전까지. 구분선은 버린다.
 */
export function sectionText(text, title) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) return '';

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => line.trim() !== '---')
    .join('\n')
    .trim();
}

/** 노션 페이지 id → 웹 URL */
export function pageUrl(page) {
  return page?.url ?? `https://www.notion.so/${String(page?.id ?? '').replaceAll('-', '')}`;
}
