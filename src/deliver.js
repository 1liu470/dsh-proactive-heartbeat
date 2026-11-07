/**
 * 投递：把一句话塞进某个会话的收件箱，并确认它真的落了盘。
 *
 * 三段式不是我发明的，是 DSH 内置 schedule 插件的写法（app.asar 里
 * @deepseek-ai/dsh-schedule/lib/index.js ~1574-1597）：
 *
 *     resolveAgent(sessionId) -> agent
 *     agent.followup(message)
 *     await sessions.flush(agent.session)   // 回 false 就是没落盘
 *
 * 为什么最后一步不能省：followup 只是把消息推进内存里的收件箱，
 * 宿主崩了、会话没持久化，这句话就不存在。flush 的返回值是唯一的回执。
 */

import { randomUUID } from "node:crypto";

let _createUserMessage;
let _factoryTried = false;

/**
 * 宿主提供的 createUserMessage 会生成稳定 id 并冻结消息。
 * 解析不到就手写等价结构——不因为拿不到工厂函数就放弃投递，
 * 但也不假装两者完全一样（见 README「已知差异」）。
 */
async function userMessageFactory() {
  if (_factoryTried) return _createUserMessage;
  _factoryTried = true;
  try {
    const mod = await import("@deepseek-ai/dsh-llm");
    _createUserMessage = typeof mod?.createUserMessage === "function" ? mod.createUserMessage : null;
  } catch {
    _createUserMessage = null;
  }
  return _createUserMessage;
}

/** @returns {Promise<object>} 一条 user 角色消息 */
export async function buildUserMessage(text, kind = "proactive-heartbeat") {
  const factory = await userMessageFactory();
  if (factory) {
    try {
      return factory({ content: [{ type: "text", text }], source: { kind } });
    } catch { /* 落到手写 */ }
  }
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  };
}

/**
 * 投递到指定会话。
 * @param {object} ctx 宿主上下文
 * @param {string} sessionId
 * @param {string} text
 * @param {{kind?:string}} [opts]
 * @throws 当会话解析不到、被委派子会话占用、或 flush 未回执
 */
export async function deliver(ctx, sessionId, text, opts = {}) {
  if (!sessionId) throw new Error("no session to deliver into");

  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  // 官方实现把「解析失败」与「成功」做成联合类型
  if (resolved && typeof resolved === "object" && "error" in resolved) throw resolved.error;
  const agent = resolved?.agent ?? resolved;
  if (!agent || typeof agent.followup !== "function") {
    throw new Error("resolveAgent returned no deliverable agent");
  }

  const message = await buildUserMessage(text, opts.kind ?? "proactive-heartbeat");
  await agent.followup(message);

  const acked = await ctx.sessions.flush(agent.session);
  if (!acked) throw new Error("session persistence did not acknowledge the message");
  return message;
}
