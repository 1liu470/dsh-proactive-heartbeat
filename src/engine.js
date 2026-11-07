/**
 * 纯决策内核。不 import 宿主任何东西，全部可单测。
 *
 * 规则的出处（都核对过源码，不是回忆）：
 *   Generative Agents —— 显著性 = 加权和 + 几何衰减，外加注意力带宽；
 *   ProactiveAgent  —— 固定节拍的心跳，只有携带信号时才问模型，且上轮反馈影响下次；
 *   Muse            —— 产品判据：一条主动消息必须「真有用」且「值得这次打断」。
 *
 * 这一层比上面三者多两样东西：显式的打扰成本项，和一道确定性前置闸门。
 * 模型永远不会被问一个答案已经是「别说」的问题。
 */

import { terms } from "./terms.js";

// ---------------------------------------------------------------------------
// 档位
// ---------------------------------------------------------------------------

/** dial -> { threshold, dailyBudget, minIdleMinutes, cooldownMinutes } */
export const DIALS = {
  off: { threshold: 9.99, dailyBudget: 0, minIdleMinutes: 1e9, cooldownMinutes: 1e9 },
  quiet: { threshold: 0.76, dailyBudget: 2, minIdleMinutes: 60, cooldownMinutes: 180 },
  normal: { threshold: 0.62, dailyBudget: 8, minIdleMinutes: 15, cooldownMinutes: 40 },
  eager: { threshold: 0.5, dailyBudget: 14, minIdleMinutes: 8, cooldownMinutes: 20 },
};

export const KINDS = ["deadline", "open_loop", "watch", "sense", "review"];
export const TYPES = ["submit", "attend", "apply", "reply", "other"];

const TYPE_RULES = [
  ["submit", /提交|上传|交(?!代)|写|报告|作业|材料|表格|填|补交/],
  ["attend", /会议|开会|集合|培训|讲座|活动|到场|见面|面试|答辩|组会/],
  ["apply", /申请|办理|报名|核对|审批|缴费|领取|确认信息/],
  ["reply", /回复|答复|表态|接龙/],
];

const ACK_WORDS = [
  "收到", "好的", "嗯", "知道了", "明白", "行了", "ok", "okay",
  "了解", "记下", "已办", "搞定", "完成了", "谢谢",
];

/**
 * 应答开头的肯定词。
 *
 * 单字「好」「行」不能塞进 ACK_WORDS —— 子串匹配会让「好像」「行业」也算应答。
 * 但它们在句首作应答极常见：真机上用户回「好，我这就去写」，既有词表一个都不中，
 * 与标题又没有共同词，于是被判成「没落到他心里」，白白罚一次偏移。
 * 用户明明接住了，系统记的是他无视。
 *
 * 光锚定句首还不够：「好像」「行业」「对方」同样以单字开头。所以单字后面必须
 * 紧跟标点或收尾，多字词才允许直接跟随。
 */
const ACK_HEAD =
  /^(?:(?:好|行|嗯|对|是|中|成)(?=[，,、。.！!？?\s吧]|$)|可以|没问题|马上|这就|我这就|去办|去写|去做)/;

export const FEEDBACK_WINDOW_SECS = 45 * 60;
/**
 * 应答期限。与 WINDOW 的区别：WINDOW 判「没回话算不算无视」，
 * TTL 判「这条 probe 还有没有意义」。一天前的提醒今天随口回句「好的」，
 * 记成有效会一路调低门槛，记成无视是凭空记账，两种都在污染账本。
 */
export const FEEDBACK_TTL_SECS = 12 * 3600;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------
// 事项
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} title
 * @property {"deadline"|"open_loop"|"watch"|"sense"|"review"} kind
 * @property {number|null} due epoch 秒
 * @property {number} weight 0..1 主观重要度
 * @property {number} created_at epoch 秒
 * @property {number} nudges
 * @property {number|null} last_nudged_at
 * @property {"open"|"done"|"dropped"} status
 * @property {string[]} tags
 * @property {string} note
 * @property {string} type submit|attend|apply|reply|other
 */

/** @returns {Item} */
export function createItem(input = {}) {
  return {
    id: String(input.id ?? ""),
    title: String(input.title ?? ""),
    kind: KINDS.includes(input.kind) ? input.kind : "open_loop",
    due: input.due == null ? null : Number(input.due),
    weight: input.weight == null ? 0.55 : Number(input.weight),
    created_at: Number(input.created_at ?? 0),
    nudges: Number(input.nudges ?? 0) | 0,
    last_nudged_at: input.last_nudged_at == null ? null : Number(input.last_nudged_at),
    status: input.status ?? "open",
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    note: String(input.note ?? ""),
    type: String(input.type ?? ""),
  };
}

export const isOpen = (item) => item?.status === "open";

// ---------------------------------------------------------------------------
// 显著性
// ---------------------------------------------------------------------------

/**
 * 0..1。截止时间走分段曲线；开放环缓慢老化。
 * @param {Item} item
 * @param {number} now epoch 秒
 */
export function urgency(item, now) {
  if (item.kind === "review") return 0.85;
  // 推测出来的需求比硬期限低一档，但必须能过门槛：定 0.55 时实测总分只有 0.57，
  // 永远低于 0.62，功能等于不存在。0.72 让它在没有更紧的事时说得出口。
  if (item.kind === "sense") return 0.72;

  if (item.due == null) {
    if (!item.created_at) return 0.35;
    const days = Math.max(0, (now - item.created_at) / 86400);
    return Math.min(0.55, 0.2 + 0.05 * days) * 0.6 ** (Math.max(0, days - 21) / 7);
  }

  const hours = (item.due - now) / 3600;
  if (hours <= 0) {
    // 逾期不会永远保持最高紧迫：一小时前错过的值得说一句，
    // 上周错过的已经是积压项；会都开完了还催「准备材料」纯属噪音。
    return Math.max(0.2, 0.88 ** (-hours / 24));
  }
  if (hours <= 24) return 0.9 - 0.2 * (hours / 24);
  if (hours <= 72) return 0.7 - 0.3 * ((hours - 24) / 48);
  if (hours <= 168) return 0.4 - 0.25 * ((hours - 72) / 96);
  return 0.15;
}

/** 首次 1.0，之后 1/(1+n)，24 小时内不再提。 */
export function novelty(item, now) {
  if (item.last_nudged_at && now - item.last_nudged_at < 86400) return 0;
  return Math.min(1, 1 / (1 + Math.max(0, item.nudges)));
}

export function relevance(item, contextTerms) {
  if (!contextTerms || contextTerms.size === 0) return 0;
  const itemTerms = terms([item.title, ...item.tags, item.note].join(" "));
  if (itemTerms.size === 0) return 0;
  let hits = 0;
  for (const t of itemTerms) if (contextTerms.has(t)) hits += 1;
  return Math.min(1, hits / 3);
}

/**
 * 两条曲线取大：短期按天衰减，长期回升。
 * 只有 0.97**days 的含义是「老了就不值得说」，第 28 天只剩 0.42。
 * 但对一个扛了三周的承诺，恰恰是「还在」才更该说。
 */
export function continuity(item, now) {
  const born = item.created_at || now;
  const days = Math.max(0, (now - born) / 86400);
  const short = 0.97 ** days;
  if (days < 7) return short;
  const longArc = 0.72 + 0.28 * Math.min(1, (days - 7) / 21);
  return Math.max(short, longArc);
}

/** 0..1。现在开口要付的代价。 */
export function interruptionCost({ dailyCount = 0, dailyBudget = 3, ignoreStreak = 0, userActive = false } = {}) {
  const budgetPressure = dailyBudget <= 0 ? 0 : Math.min(1, dailyCount / dailyBudget);
  const streakPressure = Math.min(1, ignoreStreak / 3);
  const activePressure = userActive ? 1 : 0;
  return Math.min(1, 0.3 * budgetPressure + 0.45 * streakPressure + 0.25 * activePressure);
}

/**
 * 加权显著性减打扰成本，同时把各项分量留进日志。
 * @returns {{total:number,urgency:number,importance:number,novelty:number,relevance:number,continuity:number,cost:number,base:number,type_offset:number}}
 */
export function scoreItem(item, now, contextTerms, opts = {}) {
  const {
    dailyCount = 0, dailyBudget = 3, ignoreStreak = 0,
    userActive = false, typeOffset = 0,
  } = opts;

  const u = urgency(item, now);
  const importance = clamp(item.weight, 0, 1);
  const n = novelty(item, now);
  const r = relevance(item, contextTerms);
  const c = continuity(item, now);
  const base = 0.5 * u + 0.25 * importance + 0.15 * n + 0.1 * r;
  const decayed = base * (0.4 + 0.6 * c);
  const cost = interruptionCost({
    dailyCount, dailyBudget, ignoreStreak, userActive,
  });
  const total = clamp(decayed - 0.3 * cost + typeOffset, 0, 1);

  return {
    total: r3(total),
    urgency: r3(u),
    importance: r3(importance),
    novelty: r3(n),
    relevance: r3(r),
    continuity: r3(c),
    cost: r3(cost),
    base: r3(base),
    type_offset: r3(typeOffset),
  };
}

// ---------------------------------------------------------------------------
// 类型级偏好：哪一类提醒他真的会动
// ---------------------------------------------------------------------------

export function itemType(item) {
  const t = String(item.type ?? "").trim().toLowerCase();
  if (TYPES.includes(t)) return t;
  for (const [name, pat] of TYPE_RULES) {
    if (pat.test(item.title ?? "")) return name;
  }
  return "other";
}

/**
 * 按历史响应率调该类门槛。样本 < 5 不动；上限 ±0.08，
 * 避免某一类把整个账本带偏。
 */
export function typeOffset(typeStats, t, { minSamples = 5, cap = 0.08 } = {}) {
  const d = (typeStats ?? {})[t] ?? {};
  const n = Number(d.sent ?? 0);
  if (n < minSamples) return 0;
  const rate = Number(d.engaged ?? 0) / n;
  return clamp((rate - 0.5) * 0.2, -cap, cap);
}

// ---------------------------------------------------------------------------
// 时间窗口
// ---------------------------------------------------------------------------

/** "23:00" -> 1380；非法返回 null。 */
export function parseHHMM(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** 支持跨午夜（23:00 -> 08:00）。 */
export function inQuietHours(localHm, startHm, endHm) {
  if (startHm === endHm) return false;
  if (startHm < endHm) return localHm >= startHm && localHm < endHm;
  return localHm >= startHm || localHm < endHm;
}

/** 本地日期键 YYYY-MM-DD。 */
export function localDayKey(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now * 1000));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 本地「时*60+分」。 */
export function localHHMM(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(now * 1000));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// 门控
// ---------------------------------------------------------------------------

/**
 * 主动性里所有「不问模型也能判」的部分。
 *
 * 两条空闲通道，不是一条。常规通道要求用户已离开 minIdleMinutes。
 * 紧急通道存在的原因：单通道设计下，一个整天在聊的用户永远听不到
 * 六小时后截止的事——硬期限进入紧急窗口后，用户只要静默 urgentMinIdleSeconds
 * 就可以被打断一次。
 *
 * @returns {{allowed:boolean, reason:string, item:Item|null, components:object, threshold:number, urgent:boolean}}
 */
export function gate(opts) {
  const {
    items = [], now, localHm, dial = "normal", quietHours = ["23:00", "08:00"],
    minIdleMinutes = 15, cooldownMinutes = 40, dailyBudget = 8, dailyCount = 0,
    lastInjectionAt = null, lastUserTurnAt = null, ignoreStreak = 0, contextTerms = new Set(),
    adaptiveOffset = 0, skipReason = "", urgentWindowHours = 6,
    urgentMinIdleSeconds = 180, typeStats = null, maxNudges = 2,
  } = opts;

  const d = DIALS[dial] ?? DIALS.normal;
  const verdict = (allowed, reason, extra = {}) => ({
    allowed, reason, item: extra.item ?? null, components: extra.components ?? {},
    threshold: extra.threshold ?? d.threshold, urgent: extra.urgent ?? false,
  });

  if (skipReason) return verdict(false, skipReason);
  if (dial === "off") return verdict(false, "dial=off");

  const startHm = parseHHMM(quietHours[0]);
  const endHm = parseHHMM(quietHours[1]);
  if (startHm != null && endHm != null && inQuietHours(localHm, startHm, endHm)) {
    return verdict(false, "quiet_hours");
  }

  const budget = Math.min(dailyBudget, d.dailyBudget);
  if (dailyCount >= budget) return verdict(false, `daily_budget(${dailyCount}/${budget})`);

  const userActive = lastUserTurnAt != null && now - lastUserTurnAt < 3600;

  let best = null;
  let bestComp = {};
  for (const it of items) {
    if (!isOpen(it) || !it.title) continue;

    // 催满就退场。没有这条上限，一条分数够高的事项会隔几小时再发一次——
    // 实测同一条会址集合三天里发了三次。用户没回，不代表要再说一遍。
    // 硬期限临门（6 小时内）例外一次，那是最后一次值得打断的机会。
    let cap = Math.max(1, Math.trunc(maxNudges));
    if (it.kind === "deadline" && it.due != null && it.due - now >= 0 && it.due - now <= urgentWindowHours * 3600) {
      cap += 1;
    }
    if (it.nudges >= cap) continue;

    const comp = scoreItem(it, now, contextTerms, {
      dailyCount, dailyBudget: budget, ignoreStreak, userActive,
      typeOffset: typeOffset(typeStats, itemType(it)),
    });
    if (best === null || comp.total > (bestComp.total ?? -1)) {
      best = it;
      bestComp = comp;
    }
  }

  if (best === null) return verdict(false, "no_open_items");

  // 冷却必须在选出 best 之后再判：否则紧急通道会被常规冷却先挡死，
  // 「静默三分钟就能说话」只是一句空话。硬期限临门时冷却压到三分之一。
  const soon = best.kind === "deadline" && best.due != null
    && best.due - now >= 0 && best.due - now <= urgentWindowHours * 3600;

  if (lastInjectionAt != null) {
    const gapMin = (now - lastInjectionAt) / 60;
    let cool = Math.max(cooldownMinutes, d.cooldownMinutes);
    if (soon) cool = Math.max(10, cool / 3);
    if (gapMin < cool) {
      return verdict(false, `cooldown(${Math.trunc(gapMin)}<${Math.trunc(cool)}m)`, {
        item: best, components: bestComp,
      });
    }
  }

  let urgent = false;
  const idleNeed = Math.max(minIdleMinutes, d.minIdleMinutes);
  if (lastUserTurnAt != null) {
    const idleMin = (now - lastUserTurnAt) / 60;
    if (idleMin < idleNeed) {
      if (!(soon && idleMin * 60 >= urgentMinIdleSeconds)) {
        return verdict(false, `user_active(idle ${Math.trunc(idleMin)}<${idleNeed}m)`, {
          item: best, components: bestComp,
        });
      }
      urgent = true;
    }
  }

  const eff = Math.min(0.98, d.threshold + Math.max(0, adaptiveOffset));
  if (bestComp.total < eff) {
    return verdict(false, `below_threshold(${bestComp.total}<${r3(eff)})`, {
      item: best, components: bestComp, threshold: eff,
    });
  }

  return verdict(true, urgent ? "urgent" : "passed", {
    item: best, components: bestComp, threshold: eff, urgent,
  });
}

// ---------------------------------------------------------------------------
// 反馈自适应（ProactiveAgent 的「被无视就别再吵」）
// ---------------------------------------------------------------------------

/**
 * 返回 'engaged' | 'ignored' | 'expired' | null。
 *
 * 判定不能只看「他回没回话」：同一会话里说任何一句都算有效的话，
 * 他随口回个「嗯」或继续聊别的都会被记成「这条提醒有效」，门槛一路下调，
 * 结果是越用越吵。所以要看回的内容跟这件事有没有关系。
 */
export function classifyFeedback(pending, now, userReplied, userText = "") {
  if (!pending) return null;
  const at = Number(pending.at ?? 0);
  if (now - at > FEEDBACK_TTL_SECS) return "expired";

  if (userReplied) {
    const text = String(userText ?? "").trim();
    const title = String(pending.title ?? "");
    if (ACK_WORDS.some((a) => text.toLowerCase().includes(a))) return "engaged";
    if (ACK_HEAD.test(text)) return "engaged";
    const titleTerms = terms(title);
    const replyTerms = terms(text);
    if (titleTerms.size === 0 || intersects(titleTerms, replyTerms)) return "engaged";
    // 回了话，但跟这件事毫无关系：这条提醒没落到他心里
    return "ignored";
  }

  if (now - at >= FEEDBACK_WINDOW_SECS) return "ignored";
  return null;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** 无视：每次 +0.04（上限 0.14）。有效：-0.03。 */
export function nextAdaptiveOffset(current, outcome) {
  if (outcome === "ignored") return r3(Math.min(0.14, current + 0.04));
  if (outcome === "engaged") return r3(Math.max(0, current - 0.03));
  return current;
}

/**
 * 结算一条提醒后的累计统计。抽成纯函数，好让测试直接断言，
 * 不必隔着宿主事件去验。
 *
 * 两条通路各管一件事：
 *   ignored → 全局偏移上抬、连续未回 +1（整体越来越收着）
 *   engaged → 偏移回落、连续未回清零、该类型的响应 +1（这一类型值得多说）
 *
 * engaged 这一条曾经漏了：typeOffset 要 `engaged/sent` 的比值，
 * 分子永远停在 0，样本攒到 5 条也只会推出负偏移 —— 学到的结论恒为「少说」。
 */
export function applyFeedbackStats(stats, outcome, type) {
  const s = stats ?? {};
  s.adaptive_offset = nextAdaptiveOffset(s.adaptive_offset ?? 0, outcome);
  if (outcome === "ignored") {
    s.ignore_streak = (s.ignore_streak ?? 0) + 1;
  } else if (outcome === "engaged") {
    s.ignore_streak = 0;
    if (type) {
      s.type_stats = s.type_stats ?? {};
      s.type_stats[type] = s.type_stats[type] ?? { sent: 0, engaged: 0 };
      s.type_stats[type].engaged = (s.type_stats[type].engaged ?? 0) + 1;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// 话术素材
// ---------------------------------------------------------------------------

export function humanizeDue(due, now) {
  if (due == null) return "无截止时间";
  const delta = due - now;
  if (delta <= 0) return `已逾期 ${Math.round(Math.abs(delta) / 3600)} 小时`;
  if (delta < 3600) return `还有 ${Math.round(delta / 60)} 分钟`;
  if (delta < 86400) return `还有 ${(delta / 3600).toFixed(1)} 小时`;
  return `还有 ${(delta / 86400).toFixed(1)} 天`;
}

export function summarizeItems(items, now, limit = 5) {
  return items
    .filter(isOpen)
    .slice()
    .sort((a, b) => (a.due ?? 9e18) - (b.due ?? 9e18))
    .slice(0, limit)
    .map((it) => `- ${it.title}（${humanizeDue(it.due, now)}）`)
    .join("\n");
}

export { ACK_WORDS };
