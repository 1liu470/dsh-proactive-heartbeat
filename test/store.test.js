import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import { Store, emptyState } from "../src/store.js";

async function tmpStore(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "phb-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return new Store(dir);
}

test("空目录读到空状态，不抛", async (t) => {
  const s = await tmpStore(t);
  const st = await s.read();
  assert.deepEqual(st.items, []);
  assert.equal(st.pending, null);
  assert.equal(st.daily.count, 0);
});

test("update 写入后能读回", async (t) => {
  const s = await tmpStore(t);
  await s.update((st) => { st.items.push({ id: "a", title: "交表" }); });
  const st = await s.read();
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].title, "交表");
});

test("并发二十次 update，一条不丢", async (t) => {
  const s = await tmpStore(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      s.update((st) => {
        st.items.push({ id: `i${i}`, title: `事项${i}` });
      })),
  );
  const st = await s.read();
  assert.equal(st.items.length, 20, `实际 ${st.items.length}`);
  assert.equal(new Set(st.items.map((x) => x.id)).size, 20);
});

test("mutator 抛错不写盘，也不毒死队列", async (t) => {
  const s = await tmpStore(t);
  await assert.rejects(s.update(() => { throw new Error("boom"); }));
  await s.update((st) => { st.items.push({ id: "ok", title: "后续仍可写" }); });
  const st = await s.read();
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].id, "ok");
});

test("坏掉的状态文件留档后重来", async (t) => {
  const s = await tmpStore(t);
  await s.ensureDir();
  await fsp.writeFile(path.join(s.dir, "state.json"), "{ 这不是 json", "utf8");
  const st = await s.read();
  assert.deepEqual(st.items, []);
  const files = await fsp.readdir(s.dir);
  assert.ok(files.some((f) => f.includes(".broken-")), `留档文件缺失：${files}`);
});

test("决策日志按大小轮转，只留尾部", async (t) => {
  const s = await tmpStore(t);
  await s.ensureDir();
  const logPath = path.join(s.dir, "decisions.jsonl");
  const line = JSON.stringify({ ts: 1, kind: "filler", pad: "x".repeat(80) });
  await fsp.writeFile(logPath, `${Array.from({ length: 20000 }, () => line).join("\n")}\n`, "utf8");

  const before = (await fsp.stat(logPath)).size;
  assert.ok(before > 1_000_000, `需要先超过阈值，实际 ${before}`);

  await s.log("trigger", { ok: true });

  const raw = await fsp.readFile(logPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert.ok(lines.length <= 1500, `轮转后仍有 ${lines.length} 行`);
  assert.match(lines[lines.length - 1], /"kind":"trigger"/);
});

test("空状态结构稳定", () => {
  const st = emptyState();
  for (const k of ["items", "pending", "daily", "stats", "sessions", "cursor"]) {
    assert.ok(k in st, `缺字段 ${k}`);
  }
});
