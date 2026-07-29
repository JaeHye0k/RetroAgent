import { guideQuote, heading2, headingText, scaffold, SECTIONS } from './blocks.js';
import { pageTitleFor } from './schedule.js';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 회고 DB 의 속성 이름 */
export const PROPS = { title: '이름', date: '날짜', cycle: '주기' };
export const DAILY_CYCLE = '일간';

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

  /** 해당 날짜의 '일간' 회고 페이지를 찾는다. 없으면 null. */
  async findDailyPage(dateString) {
    const result = await this.request('POST', `/databases/${this.dbId}/query`, {
      page_size: 5,
      filter: {
        and: [
          { property: PROPS.date, date: { equals: dateString } },
          { property: PROPS.cycle, select: { equals: DAILY_CYCLE } },
        ],
      },
    });
    return result.results?.[0] ?? null;
  }

  async createDailyPage(dateString) {
    return this.request('POST', '/pages', {
      parent: { database_id: this.dbId },
      properties: {
        [PROPS.title]: { title: [{ type: 'text', text: { content: pageTitleFor(dateString) } }] },
        [PROPS.date]: { date: { start: dateString } },
        [PROPS.cycle]: { select: { name: DAILY_CYCLE } },
      },
      children: scaffold(),
    });
  }

  async findOrCreateDailyPage(dateString) {
    const existing = await this.findDailyPage(dateString);
    if (existing) return { page: existing, created: false };
    return { page: await this.createDailyPage(dateString), created: true };
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
  async appendToSection(pageId, sectionTitle, children, { topLevelBlocks } = {}) {
    if (!children.length) return [];

    const blocks = topLevelBlocks ?? (await this.listChildren(pageId));
    const headingIndex = blocks.findIndex((block) => headingText(block) === sectionTitle);

    if (headingIndex === -1) {
      const section = Object.values(SECTIONS).find((s) => s.title === sectionTitle);
      const preamble = section
        ? [heading2(section.title, section.color), guideQuote(section.guide)]
        : [heading2(sectionTitle, 'default')];
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
        if (block.type === 'quote') return `> ${text}`;
        return text;
      })
      .filter(Boolean)
      .join('\n');
  }
}

/** 노션 페이지 id → 웹 URL */
export function pageUrl(page) {
  return page?.url ?? `https://www.notion.so/${String(page?.id ?? '').replaceAll('-', '')}`;
}
