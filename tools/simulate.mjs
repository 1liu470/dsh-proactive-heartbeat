/**
 * 端到端演练：用一个假宿主跑整条链路。
 *
 * 它证明的是「我这套代码自己能跑通」，不证明「DSH 里能跑通」——
 * 后者要真装进宿主才算。所以这个脚本的最后一行永远会说出这句话。
 *
 * 用法：node tools/simulate.mjs
 */

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import { apply } from "../src/index.js";
import { Store } from "../src/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, msg) => {
  if (!cond) throw new Error(`不通过：${msg}`);
  console.log(`  ✔ ${msg}`);
};

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "phb-sim-"));

// ---- 假宿主 --------------------------------------------------------------

const handlers = [];
const delivered = [];
let tool = null;

const ctx = {
  on(event, fn) {
    handlers.push({ event, fn });
    return () => {
      const i = handlers.findIndex((h) => h.fn === fn);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
  tools: {
    register(t) { tool = t; return () => { tool = null; }; },
  },
  sessionController: {
    async resolveAgent(sessionId) {
      if (!sessionId) return { error: new Error("empty session") };
      return {
        agent: {
          session: { id: sessionId },
          followup(message) { delivered.push(message); },
        },
      };
    },
  },
  sessions: {
    async flush(session) { return Boolean(session?.id); },
  },
};

const dispose = await apply(ctx, {
  state_dir: dir,
  first_delay_seconds: 3,     // 别让首轮 tick 抢在断言之前
  tick_seconds: 3600,
  timezone: "Asia/Shanghai",
  min_confidence: 0.5,
  // 静默窗口挪到凌晨三点到三点零一分：脚本要能在任何时刻跑出同一个结论。
  // 真跑的时候这一项按用户配置走，晚上不发是它该有的行为。
  quiet_hours: ["03:00", "03:01"],
});

const store = new Store(dir);
const emitUser = (text, sid = "sess-demo-1") => {
  const h = handlers.find((x) => x.event === "session/event");
  h.fn({ header: { id: sid } }, {
    type: "user/message",
    data: { message: { role: "user", content: [{ type: "text", text }] } },
  });
};

console.log("\n[1] 用户说一句话，看它记不记账");
emitUser("明天要交实验报告");
await sleep(150);
{
  const st = await store.read();
  ok(st.items.length === 1, `账本里多了一条：${st.items[0]?.title}`);
  ok(st.items[0].kind === "deadline", "判成硬期限");
  ok(st.sessions["sess-demo-1"]?.last_user_message_at > 0, "记住了这个会话刚说过话");
}

console.log("\n[2] 只回一句寒暄，不该新增事项");
emitUser("今天好累啊");
await sleep(100);
{
  const st = await store.read();
  ok(st.items.length === 1, "账本仍然只有一条");
}

console.log("\n[3] 它自己发的那条消息，不能当成用户说话");
{
  const h = handlers.find((x) => x.event === "session/event");
  const before = (await store.read()).last_user_turn_at;
  h.fn({ header: { id: "sess-demo-1" } }, {
    type: "user/message",
    data: { message: { role: "user", content: [{ type: "text", text: "快到点了：交实验报告" }], source: { kind: "proactive-heartbeat" } } },
  });
  await sleep(80);
  const after = (await store.read()).last_user_turn_at;
  ok(before === after, "自己的消息没有刷新活跃时间");
}

console.log("\n[4] 把时间往前拨、把截止拉到两小时内，然后 tick");
{
  const now = Date.now() / 1000;
  await store.update((st) => {
    st.last_user_turn_at = now - 3600;     // 一小时没说话了
    st.items[0].due = now + 2 * 3600;      // 两小时后截止
    st.items[0].weight = 0.85;
  });
  const out = await tool.execute({ action: "tick" });
  ok(out.meta?.delivered === true, `投递成功（judge: ${JSON.stringify(out.meta)}）`);
  ok(delivered.length === 1, "宿主收件箱收到一条");
  const text = delivered[0].content[0].text;
  ok(text.includes("交实验报告"), `话术里带着事：${text}`);
  ok(delivered[0].source?.kind === "proactive-heartbeat", "消息来源打了标记，下一轮不会误判成用户说话");
}

console.log("\n[5] 立刻再 tick 一次：冷却应该挡住");
{
  const out = await tool.execute({ action: "tick" });
  ok(out.meta?.allowed === false, `第二次没发（${out.meta?.reason}）`);
  ok(delivered.length === 1, "收件箱没有多出第二条");
}

console.log("\n[6] 用户回一句「好的」：结算成有效，门槛下调");
{
  // 先把偏移抬到 0.06，否则从 0 往下减到底还是 0，这条断言等于没验
  await store.update((st) => { st.stats.adaptive_offset = 0.06; });
  const before = (await store.read()).stats.adaptive_offset;
  emitUser("好的，我这就去写");
  await sleep(150);
  const st = await store.read();
  ok(st.pending === null, "待结算清空了");
  ok(st.stats.adaptive_offset < before, `自适应偏移 ${before} -> ${st.stats.adaptive_offset}`);
  ok(st.stats.ignore_streak === 0, "连续未回计数归零");
}

console.log("\n[7] 工具：列账、销账");
{
  const listed = await tool.execute({ action: "list" });
  ok(listed.text.includes("交实验报告"), "list 里能看到这件事");
  const id = (await store.read()).items[0].id;
  const done = await tool.execute({ action: "done", id });
  ok(done.text.includes("销掉"), "销账成功");
  ok((await store.read()).items[0].status === "done", "状态落成 done");
}

console.log("\n[8] 决策日志留下了可回查的痕迹");
{
  const lines = await store.tailLog(50);
  const kinds = lines.map((l) => JSON.parse(l).kind);
  ok(kinds.includes("sent"), "有一条 sent");
  ok(kinds.includes("gate"), "有门控判断记录");
  ok(kinds.includes("feedback"), "有反馈记录");
}

dispose?.();
const files = await fsp.readdir(dir);
console.log(`\n状态目录：${dir}`);
console.log(`文件：${files.join(", ")}`);
await fsp.rm(dir, { recursive: true, force: true });

console.log("\n以上只证明这套代码自己在假宿主里跑通了。");
console.log("它是否在 DSH 里跑通，要看真装进宿主之后的插件页与 decisions.jsonl。");
