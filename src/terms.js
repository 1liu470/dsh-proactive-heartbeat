/**
 * 词袋：从一段话里取出「他在说什么」。
 *
 * 上一版在 Python 里靠 jieba。DSH 是 Node 环境，装不了那套东西，
 * 于是改用 V8 自带的 Intl.Segmenter（ICU 中文分词），失败再退回双字滑窗。
 *
 * 为什么这件事值得单独一个文件：relevance 这一项全靠它。上一版用双字滑窗时，
 * 实测 136 个词里大半是跨词边界的碎片（「个怎」「要登」「站字」），
 * relevance 形同虚设，等于把 10% 的权重扔了。
 *
 * 已知短板：ICU 的词典里没有「大创」「推免」「分流」这类简称，
 * 所以 USER_WORDS 里那批词用「原文命中就补进来」的办法兜住。
 */

const STOPWORDS = new Set(`
这个 那个 哪个 什么 怎么 怎样 这么 那么 多少 为什么 如何 是否
我们 你们 他们 她们 它们 咱们 自己 别人 大家 各位
可以 需要 应该 可能 已经 还是 就是 不是 没有 因为 所以 但是 而且 然后
如果 虽然 不过 或者 以及 关于 对于 由于 因此 于是 只是 还有 一样
现在 今天 明天 昨天 后天 时候 时间 东西 事情 地方 方面 问题 情况 内容
一个 一些 一直 一下 一起 一遍 这种 那种 这样 那样 这里 那里 这些 那些
知道 觉得 认为 看看 说说 想想 试试 帮忙 麻烦 谢谢 好的 收到 明白
全部 一般 一致 大概 基本 主要 重要 直接 具体 相关 不同 一样 各种
`.trim().split(/\s+/));

/** 分词器不认识的简称。命中原文就补进来，可被配置项 user_words 追加。 */
const DEFAULT_USER_WORDS = [
  "大创", "推免", "保研", "绩点", "加权", "选课", "组会", "分流",
  "四六级", "考研", "实习", "简历", "助研", "学工", "班团", "团支书",
  "助学金", "奖学金", "实验报告", "预习报告", "毕业论文", "开题",
];

const CJK_ONLY = /^[\u4e00-\u9fff]+$/;
const LATIN_WORD = /^[a-z0-9_]{3,}$/;
const CJK_RUN = /[\u4e00-\u9fff]+/g;
const LATIN_RUN = /[a-z0-9_]{3,}/g;

let _segmenter;
let _segmenterTried = false;

function segmenter() {
  if (_segmenterTried) return _segmenter;
  _segmenterTried = true;
  try {
    _segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
  } catch {
    _segmenter = null;
  }
  return _segmenter;
}

/**
 * 词袋。拉丁词 ≥3 字符，中文按词；没有分词器就退回双字并过滤停用词。
 * @param {string} text
 * @param {number} limit 上限，超出时按字典序截断（只为定长，不代表重要性）
 * @returns {Set<string>}
 */
export function terms(text, limit = 80) {
  const out = new Set();
  if (!text) return out;
  const src = String(text);

  for (const w of src.toLowerCase().match(LATIN_RUN) ?? []) {
    if (!STOPWORDS.has(w)) out.add(w);
  }

  for (const w of DEFAULT_USER_WORDS) {
    if (src.includes(w)) out.add(w);
  }

  const seg = segmenter();
  if (seg) {
    for (const part of seg.segment(src)) {
      if (!part.isWordLike) continue;
      const w = part.segment.trim().toLowerCase();
      if (w.length < 2 || STOPWORDS.has(w)) continue;
      if (!CJK_ONLY.test(w) && !LATIN_WORD.test(w)) continue;
      out.add(w);
    }
  } else {
    for (const run of src.match(CJK_RUN) ?? []) {
      if (run.length === 1) continue;
      for (let i = 0; i + 1 < run.length; i += 1) {
        const bigram = run.slice(i, i + 2);
        if (!STOPWORDS.has(bigram)) out.add(bigram);
      }
    }
  }

  if (out.size > limit) return new Set([...out].sort().slice(0, limit));
  return out;
}

/**
 * 只取名词性的词。没有词性标注器时退化为 terms()——宁可粗糙，也不要空。
 * @param {string} text
 * @param {number} limit
 * @returns {Set<string>}
 */
export function topicTerms(text, limit = 40) {
  return terms(text, limit);
}

export { STOPWORDS, DEFAULT_USER_WORDS };
