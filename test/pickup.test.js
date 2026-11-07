import test from "node:test";
import assert from "node:assert/strict";

import { parseWhen, extractCandidates, isExplicitReminder, zonedEpoch } from "../src/pickup.js";

const TZ = "Asia/Shanghai";
// 2026-11-07 14:00 UTC = 北京时间 22:00，周六
const NOW = Date.UTC(2026, 10, 7, 14, 0) / 1000;

/** 把 epoch 渲染成北京时间的「YYYY-MM-DD HH:mm」，断言用。 */
function local(epoch) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(epoch * 1000)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

test("时区换算：北京正午是 UTC 四点", () => {
  const e = zonedEpoch(2026, 11, 8, 12, 0, TZ);
  assert.equal(new Date(e * 1000).toISOString(), "2026-11-08T04:00:00.000Z");
});

test("明天下午三点", () => {
  assert.equal(local(parseWhen("明天下午三点见", NOW, TZ)), "2026-11-08 15:00");
});

test("只说钟点、时间已过，指明天", () => {
  // 现在 22:00，说「九点」应该是明早九点
  assert.equal(local(parseWhen("九点开会", NOW, TZ)), "2026-11-08 09:00");
});

test("没给钟点时按当天结束算", () => {
  assert.equal(local(parseWhen("明天交报告", NOW, TZ)), "2026-11-08 23:59");
});

test("下周三落在下一个自然周", () => {
  // 周六(11-07) 说下周三 => 11-11
  assert.equal(local(parseWhen("下周三组会", NOW, TZ)), "2026-11-11 23:59");
});

test("周三（不加前缀）指本周内最近的那个", () => {
  assert.equal(local(parseWhen("周三交材料", NOW, TZ)), "2026-11-11 23:59");
});

test("月中日期", () => {
  assert.equal(local(parseWhen("11月20日截止", NOW, TZ)), "2026-11-20 23:59");
});

test("已过去的月日指明年", () => {
  assert.equal(local(parseWhen("1月5日报名", NOW, TZ)).slice(0, 4), "2027");
});

test("没有时间信号返回 null", () => {
  // parseWhen 只回答「有没有一个时刻」，不判断这是不是待办——那是 extractCandidates 的事
  assert.equal(parseWhen("天气不错但我不出门", NOW, TZ), null);
});

test("抽取：一句带动作与时间的待办", () => {
  const out = extractCandidates("明天要交实验报告", NOW, { timeZone: TZ });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "deadline");
  assert.equal(out[0].type, "submit");
  assert.ok(out[0].confidence >= 0.8, `confidence=${out[0].confidence}`);
  assert.equal(local(out[0].due), "2026-11-08 23:59");
});

test("抽取：问句不算待办", () => {
  assert.deepEqual(extractCandidates("明天要交吗？", NOW, { timeZone: TZ }), []);
});

test("抽取：显式提醒即使没有动作词也收", () => {
  const out = extractCandidates("提醒我下周三去一趟学院", NOW, { timeZone: TZ });
  assert.equal(out.length, 1);
  assert.ok(out[0].confidence >= 0.8);
  assert.equal(out[0].title.includes("提醒我"), false, "标题里不该留着指令前缀");
});

test("抽取：闲聊不入账", () => {
  assert.deepEqual(extractCandidates("今天好累啊", NOW, { timeZone: TZ }), []);
  assert.deepEqual(extractCandidates("嗯", NOW, { timeZone: TZ }), []);
});

test("抽取：多句各自成条", () => {
  const out = extractCandidates("明天上午十点开会。周五之前提交申请表。", NOW, { timeZone: TZ });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.type).sort(), ["attend", "submit"]);
});

test("显式提醒识别", () => {
  assert.equal(isExplicitReminder("提醒我明天带材料"), true);
  assert.equal(isExplicitReminder("别忘了提醒我周五交表"), true);
  assert.equal(isExplicitReminder("明天带材料"), false);
});
