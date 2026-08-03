import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './store.js';

/**
 * 텔레그램으로 들어온 조각글 큐.
 *
 * 원칙: 조각글은 유실되지 않는다. 큐에서 빼낼 때도 삭제가 아니라
 * data/archive/<회고날짜>.jsonl 로 옮긴다. 정리가 잘못돼도 원문이 남는다.
 */
export class Queue {
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, 'queue.jsonl');
    this.archiveDir = path.join(dir, 'archive');
    this.discardFile = path.join(this.archiveDir, 'discarded.jsonl');
  }

  async append(fragment) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(fragment)}\n`, 'utf8');
    return fragment;
  }

  async readAll() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const fragments = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        fragments.push(JSON.parse(line));
      } catch {
        // 깨진 줄은 건너뛰되 원문은 파일에 그대로 남아 있다.
        console.error('[queue] 파싱할 수 없는 줄을 건너뜁니다:', line.slice(0, 120));
      }
    }
    return fragments;
  }

  async size() {
    return (await this.readAll()).length;
  }

  /**
   * 지정한 id 들을 큐에서 빼서 아카이브로 옮긴다.
   * 스냅샷을 뜬 뒤 새로 들어온 조각은 건드리지 않는다.
   */
  async remove(ids, { retroDate }) {
    const target = new Set(ids);
    const all = await this.readAll();
    const removed = all.filter((f) => target.has(f.id));
    const kept = all.filter((f) => !target.has(f.id));

    if (removed.length) {
      await fs.mkdir(this.archiveDir, { recursive: true });
      const archiveFile = path.join(this.archiveDir, `${retroDate}.jsonl`);
      await fs.appendFile(archiveFile, removed.map((f) => `${JSON.stringify(f)}\n`).join(''), 'utf8');
    }

    await writeFileAtomic(this.file, kept.map((f) => `${JSON.stringify(f)}\n`).join(''));
    return { removed: removed.length, kept: kept.length };
  }

  /**
   * /clear · /drop — 사람이 직접 버린 조각.
   *
   * 여기서도 유실 원칙은 그대로다. 삭제가 아니라 archive/discarded.jsonl 로 옮긴다.
   * 정리를 마친 조각(archive/<날짜>.jsonl)과 파일을 나눠, 나중에 원문을 뒤질 때
   * "노션에 들어간 것"과 "내가 버린 것"을 구분할 수 있게 한다.
   *
   * 버린 조각 원문을 그대로 돌려준다. 무엇을 버렸는지 회신에 보여주기 위해서다.
   */
  async discard(ids) {
    const target = new Set(ids);
    const all = await this.readAll();
    const removed = all.filter((f) => target.has(f.id));
    if (!removed.length) return [];

    const kept = all.filter((f) => !target.has(f.id));
    const discardedAt = new Date().toISOString();
    await fs.mkdir(this.archiveDir, { recursive: true });
    await fs.appendFile(
      this.discardFile,
      removed.map((f) => `${JSON.stringify({ ...f, discardedAt })}\n`).join(''),
      'utf8',
    );

    await writeFileAtomic(this.file, kept.map((f) => `${JSON.stringify(f)}\n`).join(''));
    return removed;
  }

  /** /undo 로 되돌릴 때 조각을 큐에 되돌려 놓는다. 이미 있는 id 는 중복 추가하지 않는다. */
  async restore(fragments) {
    const existing = new Set((await this.readAll()).map((f) => f.id));
    const toRestore = fragments.filter((f) => !existing.has(f.id));
    for (const fragment of toRestore) await this.append(fragment);
    return toRestore.length;
  }
}
