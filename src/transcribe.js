/** Groq Whisper 음성 인식(STT) 클라이언트. */

export class TranscribeError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'TranscribeError';
    this.status = status;
  }
}

/** 음성 하나를 인식하는 기본 대기 한도. 텍스트 정리보다 짧게 잡는다. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

export class Transcriber {
  constructor({
    apiKey,
    model = 'whisper-large-v3-turbo',
    language = 'ko',
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    endpoint = GROQ_ENDPOINT,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.endpoint = endpoint;
  }

  /**
   * 오디오 바이트를 텍스트로 바꾼다.
   * 텔레그램 voice 는 ogg/opus 라 재인코딩 없이 그대로 보낸다. 다만 Groq 는 파일 확장자로
   * 포맷을 가리므로(.oga 는 거부) 호출부에서 filename 을 .ogg 로 넘긴다.
   */
  async transcribe(audioBuffer, { filename = 'voice.ogg', mimeType = 'audio/ogg' } = {}) {
    if (!this.apiKey) {
      throw new TranscribeError('GROQ_API_KEY 가 없어 음성을 인식할 수 없습니다');
    }

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
    form.append('model', this.model);
    if (this.language) form.append('language', this.language);
    form.append('response_format', 'json');

    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new TranscribeError(
        timedOut ? `${this.timeoutMs}ms 안에 인식 응답이 없어 끊었습니다` : `음성 인식 요청 실패: ${error.message}`,
        { cause: error },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TranscribeError(`인식 응답을 JSON 으로 읽지 못했습니다 (HTTP ${response.status})`, {
        status: response.status,
      });
    }

    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.error ?? '알 수 없는 오류';
      throw new TranscribeError(`음성 인식 실패: ${detail}`, { status: response.status });
    }

    return String(payload.text ?? '').trim();
  }
}
