/**
 * 投递层的边界用例。
 *
 * 这里不碰真宿主。它要锁的是三件在真机上会静默出错的事：
 *   · 会话解析失败必须抛，不能返回 undefined 让调用方以为发了
 *   · followup 之后 flush 回 false，必须算失败（消息只在内存里）
 *   · 拿不到 createUserMessage 工厂时，手写结构仍要能被 followup 接收
 *
 * 最后一轮真机验证（2026-11-07，profile phbcheck）走的正是手写兜底那条路，
 * 所以它不是理论分支。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildUserMessage, deliver } from "../src/deliver.js";

function fakeCtx({ resolved, flushResult = true } = {}) {
  const seen = { followup: [], flushed: [] };
  const agent = {
    session: { id: "s1" },
    async followup(msg) { seen.followup.push(msg); },
  };
  return {
    seen,
    ctx: {
      sessionController: {
        async resolveAgent() {
          if (resolved !== undefined) return resolved;
          return agent;
        },
      },
      sessions: {
        async flush(session) { seen.flushed.push(session); return flushResult; },
      },
    },
  };
}

test("buildUserMessage 生成 user 角色、带来源标记", async () => {
  const msg = await buildUserMessage("你好");
  assert.equal(msg.role, "user");
  assert.deepEqual(msg.content, [{ type: "text", text: "你好" }]);
  assert.equal(msg.source.kind, "proactive-heartbeat");
  assert.ok(msg.id, "必须有 id，否则宿主无法去重");
});

test("buildUserMessage 的 kind 可覆盖", async () => {
  const msg = await buildUserMessage("x", "custom-kind");
  assert.equal(msg.source.kind, "custom-kind");
});

test("deliver 正常路径：followup 一次、flush 一次", async () => {
  const { ctx, seen } = fakeCtx();
  const msg = await deliver(ctx, "s1", "该写报告了");
  assert.equal(seen.followup.length, 1);
  assert.equal(seen.followup[0], msg);
  assert.equal(seen.flushed.length, 1);
});

test("deliver 接受 {agent} 与裸 agent 两种返回形状", async () => {
  const bare = fakeCtx({
    resolved: { session: { id: "s2" }, async followup() {} },
  });
  await deliver(bare.ctx, "s2", "hi");
  assert.equal(bare.seen.flushed.length, 1);
});

test("deliver 遇到联合类型的 error 会抛出原错误", async () => {
  const { ctx } = fakeCtx({ resolved: { error: new Error("session busy") } });
  await assert.rejects(() => deliver(ctx, "s1", "x"), /session busy/);
});

test("deliver 解析不出 agent 时必须抛，不能静默返回", async () => {
  const { ctx } = fakeCtx({ resolved: null });
  await assert.rejects(() => deliver(ctx, "s1", "x"), /no deliverable agent/);
});

test("deliver 空 sessionId 直接拒", async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(() => deliver(ctx, "", "x"), /no session/);
});

test("flush 回 false 视为未落盘，必须抛", async () => {
  const { ctx, seen } = fakeCtx({ flushResult: false });
  await assert.rejects(() => deliver(ctx, "s1", "x"), /did not acknowledge/);
  assert.equal(seen.followup.length, 1, "followup 已经发生，这正是危险之处");
});
