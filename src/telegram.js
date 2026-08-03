import { splitForTelegram } from './render.js';

export class TelegramError extends Error {
  constructor(message, { method, status, description, cause } = {}) {
    super(message, { cause });
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

/** 일반 요청의 응답 대기 한도 */
export const DEFAULT_TIMEOUT_MS = 20_000;

export class Telegram {
  constructor({ token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 타임아웃을 반드시 건다. 잠자기에서 깨어날 때 소켓이 죽었는데도 에러가 나지
   * 않고 매달리면, 호출한 쪽의 재시도 로직이 발동하지 않아 조용히 멎어버린다.
   */
  async call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new TelegramError(
        timedOut ? `${method}: ${timeoutMs}ms 안에 응답이 없어 끊었습니다` : `${method}: ${error.message}`,
        { method, cause: error },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError(`${method}: 응답을 JSON 으로 읽지 못했습니다 (HTTP ${response.status})`, {
        method,
        status: response.status,
      });
    }

    if (!payload.ok) {
      throw new TelegramError(`${method}: ${payload.description ?? '알 수 없는 오류'}`, {
        method,
        status: response.status,
        description: payload.description,
      });
    }
    return payload.result;
  }

  getMe() {
    return this.call('getMe');
  }

  /** file_id 로 다운로드에 필요한 file_path 를 받아온다. */
  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /**
   * getFile 로 받은 file_path 의 실제 바이트를 내려받는다.
   * 봇 API(api.telegram.org/bot…)와 달리 파일은 /file/bot… 경로에서 받는다.
   */
  async downloadFile(filePath, { timeoutMs = this.timeoutMs } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new TelegramError(
        timedOut ? `파일 다운로드: ${timeoutMs}ms 안에 응답이 없어 끊었습니다` : `파일 다운로드: ${error.message}`,
        { method: 'downloadFile', cause: error },
      );
    }

    if (!response.ok) {
      throw new TelegramError(`파일 다운로드 실패 (HTTP ${response.status})`, {
        method: 'downloadFile',
        status: response.status,
      });
    }
    return response.arrayBuffer();
  }

  /**
   * long-polling. timeout 초 동안 서버가 붙들고 있다가 응답한다.
   * 끊는 한도는 그보다 넉넉히 잡아야 정상 long-poll 을 오인해 끊지 않는다.
   */
  getUpdates({ offset, timeout = 50 }) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: timeout * 1000 + 15_000 },
    );
  }

  sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...options,
    });
  }

  /**
   * 4096자를 넘으면 나눠 보낸다.
   * reply_markup 은 마지막 조각에만 붙여야 버튼이 맨 아래에 온다.
   */
  async sendLong(chatId, text, options = {}) {
    const { reply_markup: replyMarkup, ...rest } = options;
    const parts = splitForTelegram(text);
    let last;
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      last = await this.sendMessage(chatId, part, {
        ...rest,
        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
    return last;
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...options,
    });
  }

  /** 처리 끝난 미리보기에서 버튼만 떼어낸다. 이미 떼였으면 조용히 넘어간다. */
  async clearKeyboard(chatId, messageId) {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
    } catch (error) {
      console.error('[telegram] 키보드 제거 실패(무시):', error.message);
    }
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...options });
  }

  /** 조각을 받았다는 신호. 실패해도 본 흐름을 막지 않는다. */
  async react(chatId, messageId, emoji = '👌') {
    try {
      await this.call('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      });
      return true;
    } catch (error) {
      console.error('[telegram] 리액션 실패(무시):', error.message);
      return false;
    }
  }
}
