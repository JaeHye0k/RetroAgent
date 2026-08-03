import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { Queue } from '../src/queue.js';

let dir;
let queue;

const fragment = (id, text = `조각 ${id}`) => ({
  id,
  ts: '2026-07-26T14:00:00+09:00',
  text,
  messageId: id,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retro-queue-'));
  queue = new Queue({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Queue 기본 동작', () => {
  test('파일이 없으면 빈 배열', async () => {
    assert.deepEqual(await queue.readAll(), []);
    assert.equal(await queue.size(), 0);
  });

  test('append 한 순서대로 읽힌다', async () => {
    await queue.append(fragment(1));
    await queue.append(fragment(2));
    const all = await queue.readAll();
    assert.deepEqual(all.map((f) => f.id), [1, 2]);
    assert.equal(await queue.size(), 2);
  });

  test('개행이 들어간 줄글도 온전히 보존된다', async () => {
    const text = '첫 줄\n두 번째 줄\n\n네 번째';
    await queue.append(fragment(1, text));
    assert.equal((await queue.readAll())[0].text, text);
  });

  test('깨진 줄은 건너뛰고 나머지를 읽는다', async () => {
    await queue.append(fragment(1));
    await fs.appendFile(path.join(dir, 'queue.jsonl'), '{깨진 줄\n', 'utf8');
    await queue.append(fragment(2));
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [1, 2]);
  });
});

describe('Queue.remove — 삭제가 아니라 아카이브', () => {
  test('지정한 id 만 빼고 나머지는 남긴다', async () => {
    for (const id of [1, 2, 3]) await queue.append(fragment(id));

    const result = await queue.remove([1, 3], { retroDate: '2026-07-26' });
    assert.deepEqual(result, { removed: 2, kept: 1 });
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [2]);
  });

  test('빼낸 조각은 아카이브 파일에 남는다', async () => {
    await queue.append(fragment(1, '중요한 원문'));
    await queue.remove([1], { retroDate: '2026-07-26' });

    const archive = await fs.readFile(path.join(dir, 'archive', '2026-07-26.jsonl'), 'utf8');
    assert.match(archive, /중요한 원문/);
  });

  test('스냅샷 이후 들어온 조각은 건드리지 않는다', async () => {
    await queue.append(fragment(1));
    await queue.append(fragment(2));
    const snapshot = (await queue.readAll()).map((f) => f.id);

    // 정리하는 동안 새 조각이 들어왔다.
    await queue.append(fragment(99, '방금 들어온 조각'));

    await queue.remove(snapshot, { retroDate: '2026-07-26' });
    const remaining = await queue.readAll();
    assert.deepEqual(remaining.map((f) => f.id), [99]);
    assert.equal(remaining[0].text, '방금 들어온 조각');
  });

  test('없는 id 를 지워도 안전하다', async () => {
    await queue.append(fragment(1));
    const result = await queue.remove([42], { retroDate: '2026-07-26' });
    assert.deepEqual(result, { removed: 0, kept: 1 });
  });
});

describe('Queue.discard — /clear · /drop', () => {
  test('지정한 id 만 빼고 나머지는 남긴다', async () => {
    for (const id of [1, 2, 3]) await queue.append(fragment(id));

    const removed = await queue.discard([1, 3]);
    assert.deepEqual(removed.map((f) => f.id), [1, 3]);
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [2]);
  });

  test('버린 조각도 아카이브에 남는다 — 유실되지 않는다', async () => {
    await queue.append(fragment(1, '실수로 버린 원문'));
    await queue.discard([1]);

    const archive = await fs.readFile(path.join(dir, 'archive', 'discarded.jsonl'), 'utf8');
    assert.match(archive, /실수로 버린 원문/);
    assert.match(archive, /discardedAt/, '언제 버렸는지도 남는다');
  });

  test('정리를 마친 조각과 파일이 섞이지 않는다', async () => {
    await queue.append(fragment(1, '노션에 들어간 것'));
    await queue.append(fragment(2, '내가 버린 것'));

    await queue.remove([1], { retroDate: '2026-07-26' });
    await queue.discard([2]);

    const saved = await fs.readFile(path.join(dir, 'archive', '2026-07-26.jsonl'), 'utf8');
    const discarded = await fs.readFile(path.join(dir, 'archive', 'discarded.jsonl'), 'utf8');
    assert.match(saved, /노션에 들어간 것/);
    assert.doesNotMatch(saved, /내가 버린 것/);
    assert.match(discarded, /내가 버린 것/);
    assert.doesNotMatch(discarded, /노션에 들어간 것/);
  });

  test('없는 id 를 버려도 큐를 건드리지 않는다', async () => {
    await queue.append(fragment(1));
    const removed = await queue.discard([42]);
    assert.deepEqual(removed, []);
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [1]);
  });

  test('스냅샷 이후 들어온 조각은 남는다', async () => {
    await queue.append(fragment(1));
    await queue.append(fragment(2));
    const snapshot = (await queue.readAll()).map((f) => f.id);

    // /clear 확인 버튼을 누르기 전에 새 생각이 떠올랐다.
    await queue.append(fragment(99, '방금 들어온 조각'));

    await queue.discard(snapshot);
    const remaining = await queue.readAll();
    assert.deepEqual(remaining.map((f) => f.id), [99]);
  });
});

describe('Queue.restore — /undo', () => {
  test('되돌린 조각이 큐에 다시 들어온다', async () => {
    await queue.append(fragment(1));
    await queue.remove([1], { retroDate: '2026-07-26' });

    const restored = await queue.restore([fragment(1)]);
    assert.equal(restored, 1);
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [1]);
  });

  test('이미 큐에 있는 id 는 중복 추가하지 않는다', async () => {
    await queue.append(fragment(1));
    const restored = await queue.restore([fragment(1), fragment(2)]);
    assert.equal(restored, 1);
    assert.deepEqual((await queue.readAll()).map((f) => f.id), [1, 2]);
  });
});
