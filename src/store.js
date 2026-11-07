/**
 * 状态与日志。
 *
 * 两条硬规则，都是上一版用真实数据换来的：
 *
 * 1. 只有一条写入口 `update(mutator)`。读-改-写必须原子地做完，
 *    中间不能跨一次模型调用或联网检索的开窗口——那个窗口足够别的协程
 *    把 pending 清掉，然后被旧快照整份覆盖。
 * 2. 日志必须轮转。一个有 bug 的路径每几分钟写一行，一天就能把真正
 * 该看的那几行埋掉（实测 136K 全是重复）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const LOG_MAX_BYTES = 1_000_000;
const LOG_KEEP_LINES = 1500;

export function emptyState() {
  return {
    version: 1,
    items: [],
    pending: null,
    last_injection_at: null,
    last_user_turn_at: null,
    daily: { day: "", count: 0 },
    stats: { adaptive_offset: 0, ignore_streak: 0, type_stats: {} },
    sessions: {},
    cursor: {},
  };
}

export class Store {
  #dir;
  #statePath;
  #logPath;
  #queue;

  /** @param {string} dir 状态目录，例如 ~/.dsh/proactive-heartbeat */
  constructor(dir) {
    this.#dir = dir;
    this.#statePath = path.join(dir, "state.json");
    this.#logPath = path.join(dir, "decisions.jsonl");
    this.#queue = Promise.resolve();
  }

  get dir() { return this.#dir; }
  get logPath() { return this.#logPath; }

  async ensureDir() {
    await fsp.mkdir(this.#dir, { recursive: true });
  }

  /** 读当前状态。文件坏了不抛：给一份空状态，让插件继续活着。 */
  async read() {
    try {
      const raw = await fsp.readFile(this.#statePath, "utf8");
      const parsed = JSON.parse(raw);
      return { ...emptyState(), ...parsed };
    } catch (err) {
      if (err?.code === "ENOENT") return emptyState();
      // 损坏的状态文件先留档再重来，别静默丢
      try {
        await fsp.rename(this.#statePath, `${this.#statePath}.broken-${Date.now()}`);
      } catch { /* 留档失败也不阻塞 */ }
      return emptyState();
    }
  }

  async #write(state) {
    await this.ensureDir();
    const tmp = `${this.#statePath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fsp.rename(tmp, this.#statePath);
  }

  /**
   * 唯一的写入口。mutator 拿到当前状态就地改，返回值原样传出。
   * 所有 update 串行，后一个一定看到前一个的写入。
   * @template T
   * @param {(state: object) => T | Promise<T>} mutator
   * @returns {Promise<T>}
   */
  async update(mutator) {
    const run = this.#queue.then(async () => {
      const state = await this.read();
      const out = await mutator(state);
      await this.#write(state);
      return out;
    });
    // 队列不能被一次失败毒死：吞掉这轮的拒绝，只让调用方看到
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 追加一条决策日志，按大小轮转。写日志失败绝不影响主流程。 */
  async log(kind, payload = {}) {
    try {
      await this.ensureDir();
      const line = JSON.stringify({ ts: Date.now() / 1000, kind, ...payload });
      await fsp.appendFile(this.#logPath, `${line}\n`, "utf8");
      await this.#rotate();
    } catch { /* 日志是旁路 */ }
  }

  async #rotate() {
    try {
      const st = await fsp.stat(this.#logPath);
      if (st.size <= LOG_MAX_BYTES) return;
      const raw = await fsp.readFile(this.#logPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const kept = lines.slice(-LOG_KEEP_LINES);
      const tmp = `${this.#logPath}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
      await fsp.rename(tmp, this.#logPath);
    } catch { /* 轮转失败不动主流程 */ }
  }

  /** 读尾部若干行，供工具与自检用。 */
  async tailLog(n = 20) {
    try {
      const raw = await fsp.readFile(this.#logPath, "utf8");
      return raw.split("\n").filter(Boolean).slice(-n);
    } catch {
      return [];
    }
  }

  /** 同步版存在性判断，给工具做「有没有装过」的快速回答。 */
  exists() {
    return fs.existsSync(this.#statePath);
  }
}
