/**
 * 装配层的回归测试。
 *
 * 这里锁的每一条，都对应真宿主上真实踩过的一次故障：
 *   · parameters 必须是完整 JSON Schema —— 写成裸属性映射，DeepSeek 直接 400
 *     「Invalid schema for function 'proactive_heartbeat'」，模型一次也调不通
 *   · register 必须带接收者 —— 解构出来再调就报 reading 'layers' of undefined
 *   · 工具得真能 add / list / done —— 真机上「add 时必填」那次就是参数形状错了
 *   · dispose 之后不许再有心跳 —— 装两份会各发一次
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../src/index.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phb-"));
}

function fakeCtx() {
  const handlers = new Map();
  const registered = [];
  return {
    handlers,
    registered,
    ctx: {
      on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt); },
      tools: {
        // 故意用普通函数而非箭头：插件必须把 this 传进来
        register(tool) { registered.push({ tool, receiver: this }); return () => {}; },
      },
      sessionController: {
        async resolveAgent() { return null; },
      },
      sessions: {
        async flush() { return true; },
      },
    },
  };
}

const baseConfig = (dir) => ({
  state_dir: dir,
  quiet_hours: ["03:00", "03:01"],
  first_delay_seconds: 3600,   // 别让首次心跳在测试期间触发
  tick_seconds: 3600,
  timezone: "Asia/Shanghai",
});

test("apply 注册一个工具并返回 dispose", async () => {
  const dir = tmpDir();
  const { ctx, registered, handlers } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  assert.equal(typeof dispose, "function");
  assert.equal(registered.length, 1);
  assert.ok(handlers.has("session/event"));
  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parameters 是完整 JSON Schema —— 裸属性映射会被模型 API 打回", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  const { tool } = registered[0];

  assert.equal(tool.parameters.type, "object", "缺 type:object 外壳，DeepSeek 报 Invalid schema for function");
  assert.ok(tool.parameters.properties, "属性必须在 properties 下，不能平铺");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.equal(tool.parameters.properties.action.type, "string");
  assert.ok(Array.isArray(tool.parameters.properties.action.enum));

  // 宿主对 object 节点要求 additionalProperties 显式给出
  assert.equal(typeof tool.output.schema.additionalProperties, "boolean");
  assert.deepEqual(tool.output.schema.required, ["text"]);

  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("register 拿得到 this —— 解构会丢接收者", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  assert.equal(registered[0].receiver, ctx.tools);
  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("add → list → done 走一遍账本", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  const { tool } = registered[0];

  const added = await tool.execute({ action: "add", title: "写实验报告", due: "明天下午三点" });
  assert.match(added.text, /写实验报告/);
  assert.match(added.meta.id, /^it_/);
  assert.ok(added.meta.due > Date.now() / 1000, "「明天下午三点」应解析成未来时刻");

  const listed = await tool.execute({ action: "list" });
  assert.match(listed.text, /写实验报告/);
  assert.equal(listed.meta.items.length, 1);

  const done = await tool.execute({ action: "done", id: added.meta.id });
  assert.match(done.text, /销掉了/);

  const after = await tool.execute({ action: "list" });
  assert.equal(after.text, "账本空着。");

  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("add 缺 title 时给出明确错误，不写半条空事项", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  const { tool } = registered[0];

  const r = await tool.execute({ action: "add", title: "   " });
  assert.equal(r.meta.error, "missing_title");

  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.text, "账本空着。");

  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("done 用不存在的 id 时如实说没有，不假装成功", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  const { tool } = registered[0];

  const r = await tool.execute({ action: "done", id: "it_nope" });
  assert.equal(r.meta.error, "not_found");
  assert.match(r.text, /没有这个 id/);

  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("status 在空账本上也能给出可读回答", async () => {
  const dir = tmpDir();
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  const { tool } = registered[0];

  const r = await tool.execute({ action: "status" });
  assert.match(r.text, /档位 normal/);
  assert.match(r.text, /未结 0 条/);
  assert.match(r.text, /待结算：无/);

  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispose 之后事件不再被处理", async () => {
  const dir = tmpDir();
  const { ctx, handlers } = fakeCtx();
  const dispose = await apply(ctx, baseConfig(dir));
  dispose();
  assert.equal(handlers.size, 0, "dispose 必须把监听撤干净，否则装两份会各发一次");
  fs.rmSync(dir, { recursive: true, force: true });
});
