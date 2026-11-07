/**
 * DSH 主动心跳。
 *
 * 装配三件事，此处之外没有逻辑：
 *   1. 听会话事件 —— 谁在说话、说了什么，够不够记成一笔事；
 *   2. 定时 tick —— 该不该开口，说什么，说完记回账本；
 *   3. 注册工具 —— 让模型（和用户）能查账、补账、销账。
 *
 * 一条贯穿全文件的规矩：任何失败都只降级，不冒泡。插件炸掉不该带走宿主，
 * 但每一次静默失败都留一行日志——不然「没提醒」和「提醒坏了」看起来一样。
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";

import { Store } from "./store.js";
import * as E from "./engine.js";
import { terms } from "./terms.js";
import { extractCandidates, isExplicitReminder, parseWhen } from "./pickup.js";
import { deliver } from "./deliver.js";

export const name = "dsh-proactive-heartbeat";
// 三个都要声明：cordis 的属性访问只沿 fiber 父链找已注册的服务，
// 没声明就去取 ctx.tools 会直接 throw（实测报 "cannot get property tools without inject"）。
export const inject = ["tools", "sessionController", "sessions"];

const DEFAULTS = {
  dial: "normal",
  quiet_hours: ["23:00", "08:00"],
  tick_seconds: 900,
  daily_budget: 8,
  cooldown_minutes: 40,
  min_idle_minutes: 15,
  urgent_window_hours: 6,
  urgent_min_idle_seconds: 180,
  max_nudges: 2,
  timezone: "Asia/Shanghai",
  min_confidence: 0.55,
  state_dir: "",
  dry_run: false,
  first_delay_seconds: 90,
};

// ---------------------------------------------------------------------------
// 取字段：宿主结构可能变，读不到就返回空，绝不因一个字段崩掉整条链路
// ---------------------------------------------------------------------------

const sessionIdOf = (session) => session?.header?.id ?? session?.id ?? "";

/**
 * DSH 会在用户消息的 content 里**排在最前面**塞几块系统上下文（本次实测：
 * "Time sampled while preparing turn 1…"、"Browser time zone for this request…"、
 * "Elapsed since the preceding model-visible…"）。若照单全收，recent_text 与
 * 待办抽取读到的全是这些，用户原话一个字都进不来。
 *
 * 判据取「块首特征」而不是精确全文：宿主改文案时只是漏过滤，不会把用户的话吞掉。
 *
 * **过滤后为空就返回空串，不要回退全拼。** 这里原先写了个「有总比没有强」的兜底，
 * 结果真机上被反咬：DSH 每轮注入的 runtime-context 消息**整条只有系统块**，
 * 回退之后它被当成一句用户发言，既刷新了活跃时间，又把待结算判成 ignored。
 */
const SYSTEM_BLOCK = /^(Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding|Current date and time|Current runtime context|Current working directory|\[SYSTEM\])/i;

/** 两句话是不是同一句。用来认自己刚发出去的那条回声。 */
function sameText(a, b) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 宿主可能在正文外面包一层上下文，只认「足够长的一边被另一边整段包含」，
  // 太短的词不参与包含判断，否则用户回一个「好」就会被当成回声吞掉。
  if (y.length >= 8 && x.includes(y)) return true;
  if (x.length >= 8 && y.includes(x)) return true;
  return false;
}

export function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((part) => (typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : ""))
    .filter(Boolean)
    .filter((p) => !SYSTEM_BLOCK.test(p.trim()))
    .join("\n")
    .trim();
}

/**
 * 这条消息是不是人说的。
 *
 * DSH 给每条 user/message 都标了 `source.kind`，真人固定是 `"user"`。其余实测见过的：
 *   runtime-context   每轮注入的工作目录、沙箱策略、文件策略
 *   time-context      「Time sampled while preparing turn N」
 *   skill-catalog     `<system-reminder>` 技能清单
 *   model-selection   「[model changed: …]」切模型的提示
 *   proactive-heartbeat  本插件自己发出去的提醒
 *
 * 早先按正文前缀过滤，只认得前三种；`model-selection` 那句 `[model changed: …]`
 * 没有任何系统前缀，于是被当成用户回话，把刚发出去的提醒结算成 ignored。
 * 判断来源比猜正文可靠：宿主换个措辞不会骗过人，多插一类上下文也不会漏。
 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind;
  // 没标来源的（老宿主、手工构造）照旧往下走，交给正文过滤兜底，不静默丢消息
  return !kind || kind === "user";
}

function isOwnMessage(message) {
  return message?.source?.kind === "proactive-heartbeat";
}

// ---------------------------------------------------------------------------
// 话术
// ---------------------------------------------------------------------------

/**
 * 没有模型参与时的说话方式。刻意短：一条提醒的价值在「说对了事」，
 * 不在措辞。三种语气按紧近程度分，因为「还有六小时」和「过了两天」
 * 不该用同一个开头。
 */
export function composeMessage(item, now) {
  const due = E.humanizeDue(item.due, now);
  const hours = item.due == null ? null : (item.due - now) / 3600;
  let head;
  if (item.due != null && item.due <= now) head = `有件事过点了：${item.title}`;
  else if (hours != null && hours <= 6) head = `快到点了：${item.title}`;
  else if (hours != null && hours <= 30) head = `提一句：${item.title}`;
  else head = `还挂着这件事：${item.title}`;

  const tail = item.note ? `（${item.note}）` : "";
  return `${head}，${due}${tail}`;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx 宿主上下文
 * @param {object} [config] cordis.patch.yml 里这一行插件的 config
 * @returns {() => void} disposer
 */
export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const stateDir = cfg.state_dir
    ? cfg.state_dir.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), ".dsh", "proactive-heartbeat");

  const store = new Store(stateDir);
  const disposers = [];
  let timer = null;
  let firstTimer = null;
  let ticking = false;
  let disposed = false;

  const logPath = path.join(stateDir, "plugin.log");
  function log(line) {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch { /* 日志坏了不影响心跳 */ }
  }

  await store.ensureDir();
  log(`启动：dial=${cfg.dial} tick=${cfg.tick_seconds}s 目录=${stateDir}`);

  // ---- 事件 -----------------------------------------------------------------

  async function onUserMessage(sessionId, text) {
    const now = Date.now() / 1000;
    let outcome = null;

    // 宿主会把我们刚 followup 的那条消息回灌成一条 user/message。判据是
    // 「待结算还挂着，且正文与刚发出去的是同一句」——它是回声，不是用户说话。
    //
    // 不拦的后果是真机上量出来的：sent 之后 40 毫秒就记了一条 ignored，
    // ignore_streak +1、adaptive_offset 0 → 0.04。每次提醒都自我惩罚一次，
    // 偏移一路涨到上限，最后再也不开口——而人会以为「它自己安静了」。
    {
      const snap = await store.read();
      if (snap.pending && sameText(snap.pending.text, text)) {
        await store.log("echo", { session: sessionId, item_id: snap.pending.item_id ?? null });
        return;
      }
    }

    await store.update((st) => {
      st.last_user_turn_at = now;
      st.sessions[sessionId] = {
        ...(st.sessions[sessionId] ?? {}),
        last_user_message_at: now,
        // 只为 relevance 留一手：最近说过什么词
        recent_text: text.slice(0, 240),
      };

      // 先结算上一条提醒：他回了话，这条提醒就算有了结果
      //
      // 只在**提醒发到的那个会话**里结算。真机上用户去开一个新会话随口问一句，
      // 旧会话那条待结算就被判成「没落到他心里」——人根本没看见那条提醒。
      // pending 里存着 session，比对一下即可。
      if (st.pending && st.pending.session === sessionId) {
        outcome = E.classifyFeedback(st.pending, now, true, text);
        if (outcome === "engaged" || outcome === "ignored" || outcome === "expired") {
          if (outcome !== "expired") {
            // 统计口径收进引擎，两条通路（全局偏移、按类型响应率）在那一处一起改，
            // 免得又漏掉一侧 —— 之前 engaged 就漏在按类型这一侧。
            E.applyFeedbackStats(st.stats, outcome, st.pending.type);
          }
          st.pending = null;
        }
      }

      // 再记账：这句里有没有一件要做的事
      if (!isExplicitReminder(text) && text.length < 4) return;
      for (const cand of extractCandidates(text, now, { timeZone: cfg.timezone })) {
        if (cand.confidence < cfg.min_confidence) continue;
        const key = normTitle(cand.title);
        const dup = st.items.some((it) => it.status === "open" && normTitle(it.title) === key);
        if (dup) continue;
        st.items.push(E.createItem({
          id: `it_${randomUUID().slice(0, 8)}`,
          title: cand.title,
          kind: cand.kind,
          due: cand.due,
          weight: cand.weight,
          created_at: now,
          type: cand.type,
          note: "",
        }));
      }
    });

    if (outcome) await store.log("feedback", { outcome, session: sessionId, by: "event" });
  }

  function attachEvents() {
    const handler = (session, event) => {
      try {
        if (disposed) return;
        const sid = sessionIdOf(session);
        if (!sid) return;
        const type = event?.type;
        if (type !== "user/message") return;
        const msg = event?.data?.message ?? event?.data;
        if (!isHumanMessage(msg) || isOwnMessage(msg)) return;
        const text = textOf(msg);
        if (!text) return;
        onUserMessage(sid, text).catch((e) => log(`记账失败：${e?.message ?? e}`));
      } catch (e) {
        log(`事件处理异常：${e?.message ?? e}`);
      }
    };
    disposers.push(ctx.on("session/event", handler));
  }

  // ---- tick ----------------------------------------------------------------

  async function tick(trigger = "timer") {
    if (ticking || disposed) return { skipped: "busy" };
    ticking = true;
    try {
      const now = Date.now() / 1000;
      const day = E.localDayKey(now, cfg.timezone);
      const localHm = E.localHHMM(now, cfg.timezone);

      // 第一段：把过期的 pending 结掉。单独一次提交，不跨投递。
      let expired = null;
      await store.update((st) => {
        if (st.daily.day !== day) {
          st.daily = { day, count: 0 };
        }
        if (st.pending) {
          const outcome = E.classifyFeedback(st.pending, now, false, "");
          if (outcome === "ignored") {
            E.applyFeedbackStats(st.stats, "ignored", st.pending.type);
            expired = "ignored";
          } else if (outcome === "expired") {
            expired = "expired";
          }
          if (outcome) st.pending = null;
        }
      });
      if (expired) await store.log("feedback", { outcome: expired, by: "timeout" });

      // 第二段：读一次快照，判要不要开口
      const st = await store.read();
      const sessionId = pickSession(st);

      const openItems = (st.items ?? []).filter(E.isOpen);
      const contextTerms = recentTerms(st, now);

      const verdict = E.gate({
        items: openItems,
        now,
        localHm,
        dial: cfg.dial,
        quietHours: cfg.quiet_hours,
        minIdleMinutes: cfg.min_idle_minutes,
        cooldownMinutes: cfg.cooldown_minutes,
        dailyBudget: cfg.daily_budget,
        dailyCount: st.daily?.count ?? 0,
        lastInjectionAt: st.last_injection_at,
        lastUserTurnAt: st.last_user_turn_at,
        ignoreStreak: st.stats?.ignore_streak ?? 0,
        contextTerms,
        adaptiveOffset: st.stats?.adaptive_offset ?? 0,
        skipReason: sessionId ? "" : "no_session",
        typeStats: st.stats?.type_stats ?? null,
        maxNudges: cfg.max_nudges,
        urgentWindowHours: cfg.urgent_window_hours,
        urgentMinIdleSeconds: cfg.urgent_min_idle_seconds,
      });

      await store.log("gate", {
        trigger,
        allowed: verdict.allowed,
        reason: verdict.reason,
        item_id: verdict.item?.id ?? null,
        item_title: verdict.item?.title ?? null,
        score: verdict.components?.total ?? null,
        components: verdict.components,
        threshold: verdict.threshold,
        urgent: verdict.urgent,
      });

      if (!verdict.allowed) return { allowed: false, reason: verdict.reason };

      const item = verdict.item;
      const text = composeMessage(item, now);

      if (cfg.dry_run) {
        await store.log("dry_run", { item_id: item.id, title: item.title, text });
        return { allowed: true, dry_run: true, text };
      }

      // 第三段：投递。失败只记账，不重试——重试等于把打扰翻倍。
      try {
        await deliver(ctx, sessionId, text);
      } catch (e) {
        log(`投递失败：${e?.message ?? e}`);
        await store.log("deliver_failed", { item_id: item.id, session: sessionId, error: String(e?.message ?? e) });
        return { allowed: true, delivered: false, error: String(e?.message ?? e) };
      }

      await store.update((s) => {
        const t = s.items.find((it) => it.id === item.id);
        if (t) {
          t.nudges = (t.nudges ?? 0) + 1;
          t.last_nudged_at = now;
        }
        s.last_injection_at = now;
        s.daily.count = (s.daily?.count ?? 0) + 1;
        s.pending = { at: now, item_id: item.id, title: item.title, session: sessionId, text };
        const ty = E.itemType(item);
        s.stats.type_stats = s.stats.type_stats ?? {};
        s.stats.type_stats[ty] = s.stats.type_stats[ty] ?? { sent: 0, engaged: 0 };
        s.stats.type_stats[ty].sent += 1;
        // 类型得跟着 pending 走：结算发生在另一条事件里，那时已经找不到这件事项了。
        s.pending.type = ty;
      });

      await store.log("sent", {
        item_id: item.id, item_title: item.title, score: verdict.components?.total ?? null,
        urgent: verdict.urgent, session: sessionId, text,
      });
      return { allowed: true, delivered: true, text };
    } catch (e) {
      log(`tick 异常：${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    } finally {
      ticking = false;
    }
  }

  /** 最近说话的会话。DSH 是本地单机，没有「平台」这一层要过。 */
  function pickSession(st) {
    const entries = Object.entries(st.sessions ?? {});
    if (entries.length === 0) return "";
    entries.sort((a, b) => (b[1]?.last_user_message_at ?? 0) - (a[1]?.last_user_message_at ?? 0));
    const [sid, meta] = entries[0];
    // 24 小时没说过话的会话不再打扰：人可能已经不用这台机了
    if (Date.now() / 1000 - (meta?.last_user_message_at ?? 0) > 86400) return "";
    return sid;
  }

  /** 最近三轮的用词，喂给 relevance。 */
  function recentTerms(st, now) {
    const set = new Set();
    for (const meta of Object.values(st.sessions ?? {})) {
      if (!meta?.recent_text) continue;
      if (now - (meta.last_user_message_at ?? 0) > 6 * 3600) continue;
      for (const t of terms(meta.recent_text)) set.add(t);
    }
    return set;
  }

  function schedule() {
    const ms = Math.max(60, Number(cfg.tick_seconds) || 900) * 1000;
    firstTimer = setTimeout(() => { tick("first").catch((e) => log(`首轮 tick 失败：${e?.message ?? e}`)); }, Math.max(10, cfg.first_delay_seconds) * 1000);
    timer = setInterval(() => { tick("timer").catch((e) => log(`定时 tick 失败：${e?.message ?? e}`)); }, ms);
    firstTimer.unref?.();
    timer.unref?.();
  }

  // ---- 工具 ----------------------------------------------------------------

  const toolObj = {
    name: "proactive_heartbeat",
    description:
      "查看和修改主动心跳的账本。action=status 看当前档位、今日已发数、最近一次判断；"
      + "action=list 列出所有未完成事项；action=add 补记一件事（title 必填，due 可写「明天15:00」这类中文时间）；"
      + "action=done 销掉一件事（id 必填）；action=snooze 让一件事静默若干小时；action=tick 立即跑一次判断。",
    // 必须是**完整 JSON Schema**。
    //
    // 早先写成「属性名 → 值 schema」的裸映射，理由是当时报
    // `parameters.type must be a value schema object`。那个错另有出处
    // （宿主别处会按属性映射去编译），但 registry.register 本身**不编译 parameters**：
    // 它只校验 output 与 timeoutMs，然后把 parameters 原样塞进模型请求。
    // 于是模型收到的 function 定义是 {"action":{…},"title":{…}} —— 没有 type:object 外壳，
    // DeepSeek 直接 400：Invalid schema for function 'proactive_heartbeat'。
    // 官方工具的 parameters 都是 {type:'object', properties, required}，照这个写。
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "list", "add", "done", "snooze", "tick"],
          description: "status 看档位与今日用量；list 列未结事项；add 补记一条；done 销账；snooze 静默数小时；tick 立刻判一次",
        },
        title: { type: "string", description: "add 时必填：这件事叫什么" },
        due: { type: "string", description: "add 时可填：中文时间，例如「明天下午三点」「下周三」「11月20日」" },
        id: { type: "string", description: "done / snooze 时必填：事项 id，从 list 里取" },
        hours: { type: "number", description: "snooze 的小时数，默认 24" },
      },
      required: ["action"],
    },
    // output.schema 反而是完整 JSON Schema —— 与 parameters 的形状不同，别抄错。
    //
    // 但它是**受限方言**（宿主自己的 json-schema 实现，不是标准 AJV）：
    //   · `required` 不能挂在属性上（"required is not supported on type string"）
    //   · 没有 `json` 这个类型名，只能是 object/array/string/number/integer/boolean/null
    // see-now 的 spec 里两种写法都有，那是被 defineTool 归一化过的；外部插件拿不到
    // defineTool，就得自己写成合法形式。
    // output.schema 也是完整 JSON Schema，且宿主对 object 节点要求
    // additionalProperties 显式给出（compileValueSchema 里没有默认值）。
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          meta: { type: "object", additionalProperties: true },
        },
        required: ["text"],
        additionalProperties: false,
      },
      render(args, value) {
        return [{ type: "text", text: String(value?.text ?? "") }];
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return false;   // tick 会动状态，两个并发调用的判断会互相盖掉
    },
    async execute(args = {}) {
      const now = Date.now() / 1000;
      const action = String(args.action ?? "status");

      if (action === "status") {
        const st = await store.read();
        const tail = await store.tailLog(5);
        const lines = [
          `档位 ${cfg.dial}｜今日 ${st.daily?.count ?? 0}/${cfg.daily_budget}｜未结 ${(st.items ?? []).filter(E.isOpen).length} 条`,
          `自适应偏移 ${st.stats?.adaptive_offset ?? 0}｜连续未回 ${st.stats?.ignore_streak ?? 0}`,
          st.pending ? `待结算：${st.pending.title}` : "待结算：无",
          tail.length ? `最近判断：${tail[tail.length - 1]}` : "最近判断：无",
        ];
        return { text: lines.join("\n"), meta: { state: st, tail } };
      }

      if (action === "list") {
        const st = await store.read();
        const open = (st.items ?? []).filter(E.isOpen);
        if (open.length === 0) return { text: "账本空着。", meta: { items: [] } };
        const text = open
          .slice()
          .sort((a, b) => (a.due ?? 9e18) - (b.due ?? 9e18))
          .map((it) => `- [${it.id}] ${it.title}（${E.humanizeDue(it.due, now)}｜催过 ${it.nudges ?? 0} 次）`)
          .join("\n");
        return { text, meta: { items: open } };
      }

      if (action === "add") {
        const title = String(args.title ?? "").trim();
        if (!title) return { text: "缺 title。", meta: { error: "missing_title" } };
        const due = args.due ? parseWhen(args.due, now, cfg.timezone) : null;
        const parsed = args.due && due == null
          ? extractCandidates(`提醒我 ${args.due} ${title}`, now, { timeZone: cfg.timezone })
          : [];
        const dueAt = due ?? parsed[0]?.due ?? null;
        const id = `it_${randomUUID().slice(0, 8)}`;
        await store.update((st) => {
          st.items.push(E.createItem({
            id, title, kind: dueAt != null ? "deadline" : "open_loop",
            due: dueAt, weight: 0.7, created_at: now, type: E.itemType({ title, type: "" }),
          }));
        });
        await store.log("item_added", { id, title, due: dueAt, by: "tool" });
        return { text: `记下了：[${id}] ${title}（${E.humanizeDue(dueAt, now)}）`, meta: { id, due: dueAt } };
      }

      if (action === "done" || action === "snooze") {
        const id = String(args.id ?? "").trim();
        if (!id) return { text: "缺 id。", meta: { error: "missing_id" } };
        let hit = null;
        await store.update((st) => {
          const it = (st.items ?? []).find((x) => x.id === id);
          if (!it) return;
          hit = it;
          if (action === "done") {
            it.status = "done";
          } else {
            const hours = Number(args.hours ?? 24);
            it.nudges = Math.max(0, (it.nudges ?? 0) - 1);
            it.last_nudged_at = now + Math.max(1, hours) * 3600;
          }
          if (st.pending?.item_id === id) st.pending = null;
        });
        if (!hit) return { text: `没有这个 id：${id}`, meta: { error: "not_found" } };
        await store.log(action === "done" ? "item_done" : "item_snoozed", { id, by: "tool" });
        return {
          text: action === "done" ? `销掉了：${hit.title}` : `静默 ${args.hours ?? 24} 小时：${hit.title}`,
          meta: { id },
        };
      }

      if (action === "tick") {
        const out = await tick("tool");
        return { text: JSON.stringify(out, null, 2), meta: out };
      }

      return { text: `未知 action: ${action}`, meta: { action } };
    },
  };

  // ---- 装配 ----------------------------------------------------------------

  attachEvents();

  try {
    // 必须走 ctx.tools.register(...) 调用，不能把方法解构出来再调：
    // 实现里是 this.layers.effect(...)，脱离接收者就变成 undefined.layers
    // （实测报 "Cannot read properties of undefined (reading 'layers')"）。
    if (typeof ctx.tools?.register === "function") {
      disposers.push(ctx.tools.register(toolObj));
      log("已注册工具 proactive_heartbeat");
    } else {
      log("宿主没有 tools.register —— 工具不可用，心跳照常跑");
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/already registered/i.test(msg)) {
      // 装了两份：这一份整体退掉，否则两套心跳会各发一次
      log(`工具已被注册（${msg}），本实例退出`);
      for (const d of disposers.reverse()) { try { d?.(); } catch { /* 收不干净也不能炸 */ } }
      disposed = true;
      return () => {};
    }
    log(`工具注册失败：${msg}`);
  }

  schedule();
  log("心跳已排程");

  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    for (const d of disposers.reverse()) { try { d?.(); } catch { /* 忽略 */ } }
    log("已停止");
  };
}

function normTitle(s) {
  return String(s ?? "").replace(/\s+/g, "").replace(/[，。,.！!？?、；;：:]/g, "").toLowerCase();
}

export default { name, inject, apply };
