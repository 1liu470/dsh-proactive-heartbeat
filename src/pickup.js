/**
 * 从一句中文里捞出「这是一件要做的事」。
 *
 * 边界先说清：这是启发式，不是理解。它只回答「有没有一个明确动作 + 一个明确时间」，
 * 判不了「他是不是在开玩笑」「这事是不是已经做完了」。所以：
 *   · 抽出来的东西一律带 confidence，低于阈值的直接丢；
 *   · 只入账、不立刻开口——开不开口由 engine 的门控决定；
 *   · 用户说「提醒我……」时走显式通道，那条不问规则，直接收。
 *
 * 时区换算没有依赖：Intl 拿到本地日历分量，两轮迭代收敛出真实 epoch。
 */

const ACTIONS = [
  "提交", "上传", "交", "报名", "申请", "办理", "缴费", "领取", "确认",
  "回复", "接龙", "开会", "开会", "会", "集合", "到场", "见面", "面试", "答辩",
  "讲座", "活动", "培训", "考试", "测验", "汇报", "组会", "打卡", "签到",
  "写完", "写", "改完", "改", "整理", "核对", "填", "打印", "预约", "挂号",
];

const INTENT = /(要|得|必须|需要|应该|记得|别忘了|别忘|赶不上|截止|deadline|ddl)/i;
const EXPLICIT = /^(?:请你?|帮我)?\s*(?:提醒我|记得提醒|到时候提醒|别忘了提醒)/;

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function cnNumber(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s.length === 2 && s[0] === "十") return 10 + (CN_NUM[s[1]] ?? 0);
  if (s.length === 2 && s[1] === "十") return (CN_NUM[s[0]] ?? 0) * 10;
  if (s.length === 3 && s[1] === "十") return (CN_NUM[s[0]] ?? 0) * 10 + (CN_NUM[s[2]] ?? 0);
  return null;
}

const fmtCache = new Map();
function partsIn(epochSec, timeZone) {
  let dtf = fmtCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    fmtCache.set(timeZone, dtf);
  }
  const p = Object.fromEntries(dtf.formatToParts(new Date(epochSec * 1000)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second),
    weekday: p.weekday,
  };
}

/** 某时刻在目标时区的偏移（分钟，东八区为 +480）。 */
export function tzOffsetMinutes(epochSec, timeZone) {
  const p = partsIn(epochSec, timeZone);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return (asUTC - epochSec * 1000) / 60000;
}

/** 把「目标时区的年月日时分」换成真实 epoch 秒。两轮迭代足够收敛。 */
export function zonedEpoch(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  let epoch = guess - (tzOffsetMinutes(guess, timeZone) * 60);
  epoch = guess - (tzOffsetMinutes(epoch, timeZone) * 60);
  return epoch;
}

/**
 * 解析一句话里的时间。解析不出返回 null。
 * 支持：今天/明天/后天/大后天、周X/星期X/下周X、X月Y日/号、HH:MM、X点/半。
 * @returns {number|null} epoch 秒
 */
export function parseWhen(text, now, timeZone = "Asia/Shanghai") {
  const src = String(text ?? "");
  if (!src) return null;

  const base = partsIn(now, timeZone);

  let dayOffset = null;
  let targetWeekday = null;
  let month = null;
  let day = null;

  if (/大后天/.test(src)) dayOffset = 3;
  else if (/后天/.test(src)) dayOffset = 2;
  else if (/明天|明日|明早|明晚/.test(src)) dayOffset = 1;
  else if (/今天|今日|今晚|今早/.test(src)) dayOffset = 0;

  const wd = /(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(src);
  if (wd) {
    const want = WEEKDAY[wd[2]];
    const offMin = tzOffsetMinutes(now, timeZone);
    const curDow = new Date((now + offMin * 60) * 1000).getUTCDay();
    const mod = (a, n) => ((a % n) + n) % n;
    const idx = want === 0 ? 6 : want - 1;          // 周一=0 … 周日=6
    const week = wd[1] === "下下" ? 2 : wd[1] === "下" ? 1 : 0;
    if (week === 0) {
      targetWeekday = mod(want - curDow, 7);        // 本周内（含今天）
    } else {
      const toMonday = 7 - mod(curDow - 1, 7);      // 距下一个周一
      targetWeekday = toMonday + (week - 1) * 7 + idx;
    }
  }

  const md = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/.exec(src);
  if (md) {
    month = cnNumber(md[1]);
    day = cnNumber(md[2]);
  } else {
    const dm = /(\d{1,2})\s*[日号](?!\s*[线楼床房])/.exec(src);
    if (dm) day = Number(dm[1]);
  }

  const hm = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(src);
  let hour = null;
  let minute = 0;
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  } else {
    const pt = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时]/.exec(src);
    if (pt) {
      hour = cnNumber(pt[1]);
      if (/半/.test(src)) minute = 30;
      const q = /一刻/.test(src) ? 15 : /三刻/.test(src) ? 45 : null;
      if (q != null) minute = q;
    }
  }
  if (hour != null) {
    if (/下午|傍晚|晚上|晚|pm/i.test(src) && hour < 12) hour += 12;
    if (/中午/.test(src) && hour < 11) hour += 12;
    if (hour === 12 && /凌晨/.test(src)) hour = 0;
    if (hour >= 24) hour = hour % 24;
  }

  const hasDaySignal = dayOffset != null || targetWeekday != null || month != null || day != null;
  if (!hasDaySignal && hour == null) return null;

  let y = base.y;
  let mo = base.mo;
  let d = base.d;

  if (month != null && day != null) {
    mo = month;
    d = day;
    if (mo < base.mo) y += 1;            // 「1月5日」说在十二月时指明年
  } else if (dayOffset != null) {
    const shifted = new Date(Date.UTC(base.y, base.mo - 1, base.d + dayOffset));
    y = shifted.getUTCFullYear();
    mo = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
  } else if (targetWeekday != null) {
    const shifted = new Date(Date.UTC(base.y, base.mo - 1, base.d + targetWeekday));
    y = shifted.getUTCFullYear();
    mo = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
  } else if (day != null) {
    d = day;
    if (d < base.d) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
  }

  // 没给钟点时按当天结束算：说「明天交」的人心里的截止不是明天零点
  let h = hour ?? 23;
  let mi = hour == null ? 59 : minute;

  let epoch = zonedEpoch(y, mo, d, h, mi, timeZone);

  // 只说了钟点、时间已过：指明天
  if (!hasDaySignal && hour != null && epoch <= now) {
    epoch = zonedEpoch(y, mo, d + 1, h, mi, timeZone);
  }
  return epoch;
}

export const isExplicitReminder = (text) => EXPLICIT.test(String(text ?? "").trim());

/**
 * 抽候选事项。
 * @param {string} text 用户原话
 * @param {number} now epoch 秒
 * @param {{timeZone?:string}} [opts]
 * @returns {Array<{title:string,kind:string,due:number|null,weight:number,type:string,confidence:number}>}
 */
export function extractCandidates(text, now, opts = {}) {
  const timeZone = opts.timeZone ?? "Asia/Shanghai";
  const raw = String(text ?? "").trim();
  if (!raw || raw.length < 4) return [];
  if (/^[?？。.!！\s]*$/.test(raw)) return [];

  const explicit = isExplicitReminder(raw);
  const sentences = raw.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);

  const out = [];
  for (const s of sentences) {
    const due = parseWhen(s, now, timeZone);
    const action = ACTIONS.find((a) => s.includes(a));
    const intent = INTENT.test(s);

    if (!due && !explicit) continue;
    if (!action && !explicit) continue;

    // 问句不是待办：「明天要交吗」
    if (/吗\s*[?？]?$|呢\s*[?？]?$/.test(s) && !explicit) continue;

    let confidence = 0.35;
    if (due != null) confidence += 0.30;
    if (action) confidence += 0.20;
    if (intent) confidence += 0.10;
    if (explicit) confidence += 0.25;
    // 纯未来式闲聊（「明天会下雨」）动作词命中率低，已被 action 条件挡掉
    confidence = Math.min(1, confidence);

    const title = cleanTitle(s);
    if (!title) continue;

    out.push({
      title,
      kind: due != null ? "deadline" : "open_loop",
      due,
      weight: explicit ? 0.8 : due != null ? 0.62 : 0.5,
      type: guessType(s),
      confidence: Math.round(confidence * 100) / 100,
    });
  }
  return out;
}

function cleanTitle(s) {
  let t = s
    .replace(EXPLICIT, "")
    .replace(/^(?:那个|然后|另外|还有|对了|诶|哎)[，,]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 48) t = `${t.slice(0, 48)}…`;
  return t;
}

function guessType(s) {
  if (/提交|上传|交|写|报告|作业|材料|填|补交/.test(s)) return "submit";
  if (/会议|开会|集合|培训|讲座|活动|到场|见面|面试|答辩|组会/.test(s)) return "attend";
  if (/申请|办理|报名|核对|审批|缴费|领取|确认信息/.test(s)) return "apply";
  if (/回复|答复|表态|接龙/.test(s)) return "reply";
  return "other";
}
