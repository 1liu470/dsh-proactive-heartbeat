import test from "node:test";
import assert from "node:assert/strict";

import { isHumanMessage, textOf } from "../src/index.js";

// 这些 source.kind 全部来自真机会话存档（session-7e535942…），不是猜的。
const SYS_KINDS = ["runtime-context", "time-context", "skill-catalog", "model-selection", "proactive-heartbeat"];

test("只有 source.kind=user 才算人说话", () => {
  assert.equal(isHumanMessage({ source: { kind: "user" } }), true);
  for (const kind of SYS_KINDS) {
    assert.equal(isHumanMessage({ source: { kind } }), false, `${kind} 不该被当成人话`);
  }
});

test("没标来源时放行，交给正文过滤兜底", () => {
  assert.equal(isHumanMessage({ content: "交实验报告" }), true);
  assert.equal(isHumanMessage({ source: {} }), true);
  assert.equal(isHumanMessage(null), true);
});

test("model-selection 那句没有系统前缀，只能靠来源拦住", () => {
  const msg = { source: { kind: "model-selection" }, content: [{ type: "text", text: "[model changed: a → b]" }] };
  // 正文过滤认不出它（没有约定前缀），所以来源判定是唯一一道闸
  assert.equal(textOf(msg), "[model changed: a → b]");
  assert.equal(isHumanMessage(msg), false);
});

test("正文过滤认得住的系统块，返回空串而不是回退全拼", () => {
  const cases = [
    "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.",
    "Time sampled while preparing turn 8, step 1: 2026-11-07T23:36:58+08:00[Asia/Shanghai]",
    "Current date and time: 2026-11-07",
    "[SYSTEM] whatever",
  ];
  for (const t of cases) {
    assert.equal(textOf({ content: [{ type: "text", text: t }] }), "", `应滤空：${t.slice(0, 24)}`);
  }
});

test("系统块与用户正文混排时，只留用户那一句", () => {
  const msg = {
    content: [
      { type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." },
      { type: "text", text: "明天要交实验报告" },
    ],
  };
  assert.equal(textOf(msg), "明天要交实验报告");
});

test("字符串形态与空形态都不炸", () => {
  assert.equal(textOf({ content: "直接一句话" }), "直接一句话");
  assert.equal(textOf({}), "");
  assert.equal(textOf(null), "");
  assert.equal(textOf({ content: [{ type: "image" }] }), "");
});
