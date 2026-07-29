import fs from 'node:fs/promises';
import path from 'node:path';

/** 디렉터리 보장 후 tmp 파일에 쓰고 rename — 쓰기 도중 죽어도 반쪽 파일이 남지 않는다. */
export async function writeFileAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

/** 작은 JSON 상태 파일 하나를 담당한다. 파일이 없거나 깨졌으면 fallback 을 돌려준다. */
export class JsonStore {
  constructor(file, fallback = null) {
    this.file = file;
    this.fallback = fallback;
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[store] ${this.file} 를 읽지 못해 기본값을 사용합니다:`, error.message);
      }
      return structuredClone(this.fallback);
    }
  }

  async write(value) {
    await writeFileAtomic(this.file, JSON.stringify(value, null, 2));
    return value;
  }

  async clear() {
    await this.write(this.fallback);
  }
}
