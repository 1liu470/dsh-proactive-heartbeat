import test from "node:test";
import assert from "node:assert/strict";

import * as E from "../src/engine.js";

// 固定基准：2026-11-07 14:00 UTC（北京时间 22:00，周六）
const NOW = Date.UTC(2026, 10, 7, 14, 0) / 1000;
const TZ = "Asia/Shanghai";
const H = 3600;

const mk = (over) => E.createItem({ id: "x", title: "交实验报告", created_at: NOW, ...over });
const baseGate = (over = {}) => ({
  items: [], now: NOW, localHm: 9 * 60, dial: "normal",
  quietHours: ["23:00", "08:00"], minIdleMinutes: 15, cooldownMinutes: 40,
  dailyBudget: 8, dailyCount: 0, lastInjectionAt: null,
  lastUserTurnAt: NOW - 3600, ignoreStreak: 0, contextTerms: new Set(),
  ...over,
});

// ---------------------------------------------------------------- 显著性

test("紧迫度：逾期一小时高于逾期一周", () => {
  const a = E.urgency(mk({ kind: "deadline", due: NOW - 1 * H }), NOW);
  const b = E.urgency(mk({ kind: "deadline", due: NOW - 24 * 7 * H }), NOW);
  assert.ok(a > b, `${a} 应大于 ${b}`);
  assert.ok(b >= 0.2, "逾期不会掉到地板以下");
});

test("紧迫度：24 小时内单调递减，且始终高于 24 小时外", () => {
  let prev = Infinity;
  for (const h of [1, 6, 12, 23]) {
    const u = E.urgency(mk({ kind: "deadline", due: NOW + h * H }), NOW);
    assert.ok(u < prev, `+${h}h 应低于前一档`);
    assert.ok(u > E.urgency(mk({ kind: "deadline", due: NOW + 30 * H }), NOW));
    prev = u;
  }
});

test("紧迫度：sense 档固定 0.72，能过 normal 门槛但不抢硬期限", () => {
  assert.equal(E.urgency(mk({ kind: "sense" }), NOW), 0.72);
  assert.ok(E.urgency(mk({ kind: "sense" }), NOW) > E.urgency(mk({ kind: "deadline", due: NOW - 30 * 24 * H }), NOW));
});

test("新鲜度：24 小时内催过就是零", () => {
  assert.equal(E.novelty(mk({ nudges: 1, last_nudged_at: NOW - 3600 }), NOW), 0);
  assert.equal(E.novelty(mk({ nudges: 0 }), NOW), 1);
  assert.equal(E.novelty(mk({ nudges: 3, last_nudged_at: NOW - 48 * H }), NOW), 0.25);
});

test("连续度：第 10 天是谷底 0.760，第 28 天回到 1.0", () => {
  const d10 = E.continuity(mk({ created_at: NOW - 10 * 86400 }), NOW);
  const d28 = E.continuity(mk({ created_at: NOW - 28 * 86400 }), NOW);
  assert.ok(Math.abs(d10 - 0.76) < 0.005, `第 10 天 ${d10}`);
  assert.ok(Math.abs(d28 - 1) < 0.005, `第 28 天 ${d28}`);
  assert.ok(d10 < d28, "扛了三周的承诺不该比刚建的轻");
});

test("打分：各分量在 0..1，总分等于公式结果", () => {
  const it = mk({ kind: "deadline", due: NOW + 6 * H, weight: 0.7 });
  const c = E.scoreItem(it, NOW, new Set(["实验报告"]), { dailyCount: 2, dailyBudget: 8 });
  for (const k of ["total", "urgency", "importance", "novelty", "relevance", "continuity", "cost", "base"]) {
    assert.ok(c[k] >= 0 && c[k] <= 1, `${k}=${c[k]} 越界`);
  }
  const expected = Math.round((c.base * (0.4 + 0.6 * c.continuity) - 0.3 * c.cost) * 1000) / 1000;
  assert.ok(Math.abs(c.total - Math.max(0, Math.min(1, expected))) < 0.002);
});

test("打扰成本：预算打满 + 连续被无视 + 用户正在说话 = 接近上限", () => {
  const c = E.interruptionCost({ dailyCount: 8, dailyBudget: 8, ignoreStreak: 3, userActive: true });
  assert.ok(c > 0.95, `${c}`);
  const light = E.interruptionCost({ dailyCount: 0, dailyBudget: 8, ignoreStreak: 0, userActive: false });
  assert.equal(light, 0);
});

// ---------------------------------------------------------------- 门控

test("档位 off 一律不发", () => {
  const v = E.gate(baseGate({ dial: "off", items: [mk({ kind: "deadline", due: NOW + H })] }));
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "dial=off");
});

test("静默时段支持跨午夜", () => {
  assert.equal(E.inQuietHours(23 * 60 + 30, 23 * 60, 8 * 60), true);
  assert.equal(E.inQuietHours(7 * 60, 23 * 60, 8 * 60), true);
  assert.equal(E.inQuietHours(12 * 60, 23 * 60, 8 * 60), false);
  const v = E.gate(baseGate({ localHm: 23 * 60 + 30, items: [mk({ kind: "deadline", due: NOW + H })] }));
  assert.equal(v.reason, "quiet_hours");
});

test("预算耗尽即停", () => {
  const v = E.gate(baseGate({ dailyCount: 8, items: [mk({ kind: "deadline", due: NOW + H })] }));
  assert.equal(v.allowed, false);
  assert.match(v.reason, /daily_budget/);
});

test("冷却挡住常规通道", () => {
  const v = E.gate(baseGate({
    lastInjectionAt: NOW - 5 * 60,
    items: [mk({ kind: "deadline", due: NOW + 48 * H })],
  }));
  assert.equal(v.allowed, false);
  assert.match(v.reason, /cooldown/);
});

test("用户刚说完话：常规通道挡住", () => {
  const v = E.gate(baseGate({
    lastUserTurnAt: NOW - 60,
    items: [mk({ kind: "deadline", due: NOW + 48 * H })],
  }));
  assert.equal(v.allowed, false);
  assert.match(v.reason, /user_active/);
});

test("紧急通道：六小时内截止，静默三分钟即可打断", () => {
  const v = E.gate(baseGate({
    lastUserTurnAt: NOW - 200,
    lastInjectionAt: NOW - 30 * 60,
    items: [mk({ kind: "deadline", due: NOW + 2 * H, weight: 0.8 })],
  }));
  assert.equal(v.allowed, true, v.reason);
  assert.equal(v.urgent, true);
});

test("催满两次就退场", () => {
  const v = E.gate(baseGate({ items: [mk({ kind: "open_loop", nudges: 2, last_nudged_at: NOW - 48 * H })] }));
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "no_open_items");
});

test("硬期限临门时上限多给一次", () => {
  const v = E.gate(baseGate({
    items: [mk({ kind: "deadline", due: NOW + 2 * H, nudges: 2, last_nudged_at: NOW - 48 * H, weight: 0.9 })],
    lastInjectionAt: NOW - 60 * 60,
  }));
  assert.equal(v.allowed, true, v.reason);
});

test("分数不够门槛就不发", () => {
  const v = E.gate(baseGate({ items: [mk({ kind: "deadline", due: NOW + 200 * H, weight: 0.1 })] }));
  assert.equal(v.allowed, false);
  assert.match(v.reason, /below_threshold/);
});

test("自适应偏移抬高门槛后，原本能过的过不去", () => {
  const items = [mk({ kind: "deadline", due: NOW + 12 * H, weight: 0.55 })];
  const passed = E.gate(baseGate({ items }));
  assert.equal(passed.allowed, true, `基线应过：${passed.reason}`);
  const blocked = E.gate(baseGate({ items, adaptiveOffset: 0.14 }));
  assert.equal(blocked.allowed, false);
});

test("没有未结事项时给 no_open_items", () => {
  assert.equal(E.gate(baseGate({ items: [] })).reason, "no_open_items");
  assert.equal(E.gate(baseGate({ items: [mk({ status: "done" })] })).reason, "no_open_items");
});

// ---------------------------------------------------------------- 反馈

test("四十五分钟内回「好的」算有效", () => {
  const p = { at: NOW - 10 * 60, title: "交实验报告" };
  assert.equal(E.classifyFeedback(p, NOW, true, "好的，我去写"), "engaged");
});

test("回了话但跟这件事无关，算无视", () => {
  const p = { at: NOW - 10 * 60, title: "交实验报告" };
  assert.equal(E.classifyFeedback(p, NOW, true, "今天食堂排队好长"), "ignored");
});

test("提到事里任何一个词也算有效", () => {
  const p = { at: NOW - 10 * 60, title: "交实验报告" };
  assert.equal(E.classifyFeedback(p, NOW, true, "实验报告我改完了"), "engaged");
});

test("四十五分钟没回话算无视，但十二小时之后直接作废", () => {
  assert.equal(E.classifyFeedback({ at: NOW - 50 * 60, title: "x" }, NOW, false), "ignored");
  assert.equal(E.classifyFeedback({ at: NOW - 13 * 3600, title: "x" }, NOW, false), "expired");
  assert.equal(E.classifyFeedback({ at: NOW - 13 * 3600, title: "x" }, NOW, true, "好的"), "expired");
  assert.equal(E.classifyFeedback(null, NOW, false), null);
});

test("自调：无视加分封顶 0.14，有效减分封底 0", () => {
  assert.equal(E.nextAdaptiveOffset(0.14, "ignored"), 0.14);
  assert.equal(E.nextAdaptiveOffset(0.12, "ignored"), 0.14);
  assert.equal(E.nextAdaptiveOffset(0, "engaged"), 0);
  assert.equal(E.nextAdaptiveOffset(0.02, "engaged"), 0);
});

// ---------------------------------------------------------------- 类型偏好

test("类型判定：动词优先，猜不出归 other", () => {
  assert.equal(E.itemType({ title: "提交材料", type: "" }), "submit");
  assert.equal(E.itemType({ title: "周三组会", type: "" }), "attend");
  assert.equal(E.itemType({ title: "交代表格", type: "" }), "submit");
  assert.equal(E.itemType({ title: "随便写写", type: "other" }), "other");
});

test("类型偏好：样本不足五条不动，上限 ±0.08", () => {
  assert.equal(E.typeOffset({ submit: { sent: 4, engaged: 4 } }, "submit"), 0);
  assert.equal(E.typeOffset({ submit: { sent: 10, engaged: 10 } }, "submit"), 0.08);
  assert.equal(E.typeOffset({ submit: { sent: 10, engaged: 0 } }, "submit"), -0.08);
});

// ------------------------------------------------------- 反馈结算的累计统计

test("被无视：偏移上抬、连续未回 +1，类型响应率不动", () => {
  const s = E.applyFeedbackStats({ adaptive_offset: 0, ignore_streak: 0, type_stats: { submit: { sent: 3, engaged: 1 } } }, "ignored", "submit");
  assert.equal(s.adaptive_offset, 0.04);
  assert.equal(s.ignore_streak, 1);
  assert.deepEqual(s.type_stats.submit, { sent: 3, engaged: 1 });
});

test("被回应：偏移回落且不越过 0、连续未回清零、该类型响应 +1", () => {
  const s = E.applyFeedbackStats({ adaptive_offset: 0.06, ignore_streak: 4, type_stats: { submit: { sent: 3, engaged: 1 } } }, "engaged", "submit");
  assert.equal(s.adaptive_offset, 0.03);
  assert.equal(s.ignore_streak, 0);
  assert.deepEqual(s.type_stats.submit, { sent: 3, engaged: 2 });
  // 下限是 0：偏移只是「越来越收着」的记账，不会变成负值去奖励多说话
  assert.equal(E.applyFeedbackStats({ adaptive_offset: 0, ignore_streak: 0 }, "engaged", null).adaptive_offset, 0);
});

test("被回应缺类型时仍清连续未回，但不凭空造类型条目", () => {
  const s = E.applyFeedbackStats({ adaptive_offset: 0.02, ignore_streak: 2, type_stats: {} }, "engaged", undefined);
  assert.equal(s.ignore_streak, 0);
  assert.deepEqual(s.type_stats, {});
});

test("engaged 攒够样本后，类型偏移会由负转正 —— 学到的不能恒是「少说」", () => {
  let stats = { adaptive_offset: 0, ignore_streak: 0, type_stats: {} };
  stats.type_stats.submit = { sent: 6, engaged: 0 };
  assert.ok(E.typeOffset(stats.type_stats, "submit") < 0);
  for (let i = 0; i < 6; i += 1) stats = E.applyFeedbackStats(stats, "engaged", "submit");
  assert.equal(stats.type_stats.submit.engaged, 6);
  assert.ok(E.typeOffset(stats.type_stats, "submit") > 0);
});

// ---------------------------------------------------------------- 时间

test("本地日期键与时刻不受机器时区影响", () => {
  assert.equal(E.localDayKey(NOW, TZ), "2026-11-07");
  assert.equal(E.localHHMM(NOW, TZ), 22 * 60);
});
