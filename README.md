# dsh-proactive-heartbeat

DeepSeek Harness 的主动心跳。它做一件事：**判断现在值不值得开口**，值得就自己组织一句话递进来，不值得就闭嘴。

不是待办清单。清单等你去看，这个等它来找你。

---

## 它怎么决定该不该说话

每次心跳算一个分：

```
base      = 0.50·紧迫 + 0.25·重要 + 0.15·新鲜 + 0.10·相关
decayed   = base × (0.40 + 0.60·连续性)
total     = clamp(decayed − 0.30·打扰成本 + 类型偏移)
```

过 `0.62` 才开口。这条线之上还有四道闸：今日预算、冷却、最小空闲、同一事项催过几次。

分不够高就不发。**沉默是默认结果，不是异常。**

说完之后它记账，等你的反应：

| 你的反应 | 它学到什么 |
|---|---|
| 十二小时内回了话，且接住了 | 这类事值得说，类型偏移下调 |
| 没回，或回得风马牛不相及 | 这类事说多了，类型偏移上调 |
| 十二小时内一直没动静 | 按过期处理，不算你没礼貌 |

于是它慢慢往你真正在意的那一侧偏，而不是照着一份固定规则念。

---

## 装

```bash
dsh plugin add "file:/path/to/dsh-proactive-heartbeat"
```

`file:` 装的是 pnpm 快照，**不是软链**。改了源码必须删掉安装副本再装一次：

```bash
rm -rf ~/.dsh/profiles/<profile>/node_modules/dsh-proactive-heartbeat
dsh plugin add "file:/path/to/dsh-proactive-heartbeat"
```

装完重启 DSH。插件靠 `dsh.plugin.json` 的 `inject` 拿宿主服务，靠 `cordis.patch.yml` 挂进插件树。

> `desktop` profile 由 Electron 独占，CLI 不能 `--dump-config`。验证新插件请另开临时 profile：
> `dsh --profile tmpcheck --from-default-profile web --dump-config`。

---

## 配

写在 profile 的 `cordis.patch.yml`：

```yaml
insert:
  - id: proactive-heartbeat
    name: dsh-proactive-heartbeat
    config:
      dial: normal
      quiet_hours: ["23:00", "08:00"]
      tick_seconds: 900
```

| 键 | 默认 | 含义 |
|---|---|---|
| `dial` | `normal` | `off` / `quiet` / `normal` / `eager` |
| `quiet_hours` | `["23:00","08:00"]` | 静默窗，支持跨午夜 |
| `tick_seconds` | `900` | 心跳间隔 |
| `daily_budget` | `8` | 每日上限 |
| `cooldown_minutes` | `40` | 两次开口的最小间隔 |
| `min_idle_minutes` | `15` | 你刚说完话就别插嘴 |
| `urgent_window_hours` | `6` | 六小时内到期算紧急，可压低空闲门槛 |
| `max_nudges` | `2` | 同一件事最多催几次 |
| `timezone` | `Asia/Shanghai` | 时间基准 |
| `min_confidence` | `0.55` | 从闲聊里认事项的置信下限 |
| `state_dir` | `~/.dsh/proactive-heartbeat` | 账本、决策日志、插件日志 |
| `dry_run` | `false` | 只记不发，用来观察它的判断 |
| `first_delay_seconds` | `90` | 启动后多久开始第一次心跳 |

档位只改四个数，不改逻辑：`quiet` 降到 4/日、90 分钟冷却；`eager` 抬到 12/日、20 分钟冷却。

---

## 工具

注册一个 `proactive_heartbeat`，六个动作：

| action | 做什么 |
|---|---|
| `status` | 档位、今日用量、未结数、自适应偏移、最近一条判断 |
| `list` | 列出未结事项，按到期排序 |
| `add` | 补记一条，`title` 必填，`due` 收中文时间（「明天下午三点」「下周三」「11月20日」） |
| `done` | 销账 |
| `snooze` | 静默若干小时 |
| `tick` | 立刻判一次，不用等下一轮 |

模型可以自己调它——查账、补账、被你一句「销了」之后动手。这也是它区别于定时器的部分：它会被人问起，也能回答。

---

## 状态在哪

```
~/.dsh/proactive-heartbeat/
├── state.json        账本、会话索引、统计
├── decisions.jsonl   每次判断的完整依据（含分数构成）
└── plugin.log        插件自身日志，超 1 MB 轮转，保留尾 1500 行
```

`decisions.jsonl` 是留给你的：每条都写着 `gate` 为什么通过或挡住，`components` 里六个分量各是多少。觉得它烦或哑，先看这个文件，别猜。

账本用单写入口 `update(mutator)` 串行提交，原子写。并发时不会丢更新。

---

## 真机验证记录

以下不是设计推演，是在 DSH 0.2.1-rc.3 上真装真跑踩出来的，逐条修掉：

| 现象 | 根因 |
|---|---|
| `cannot get property tools without inject` | `inject` 少声明 `tools` |
| `parameters.type must be a value schema object` | 工具的 `parameters` 形状写成了完整 schema |
| `Invalid schema for function 'proactive_heartbeat'` | 改回属性映射后，宿主根本不编译它，裸映射直接发给模型 API |
| `Cannot read properties of undefined (reading 'layers')` | 把 `register` 解构出来调用，丢了接收者 |
| 提醒发出去 40 毫秒后自己判成「被忽略」 | 插件发的消息被宿主回显成 `user/message`，误当用户反馈 |
| 用户在别的会话随口一问，旧会话的提醒被判「没落到心里」 | 结算没比对会话 id |
| `[model changed: …]` 被当成人话 | 判「是不是人话」看正文前缀；该看 `source.kind` |
| 回「好，我这就去写」被记成没回应 | 确认词表全是双字词，单字「好」漏了 |

最后一行值得单说：词表里「好的」在，「好」不在，而人偏偏常回「好，我这就去写」。现在按句首锚定，`好`/`行`/`嗯`/`对`/`可以`/`马上`/`这就` 都算接住了。

一次完整的真机链路：23:45 投递（`sent`，分数 0.804）→ 23:46 用户回话（`engaged`）→ `pending` 清空 → `type_stats.submit` 由 `{sent:1, engaged:0}` 变成 `{sent:1, engaged:1}`。

---

## 已知边界

**它只发私聊，而且只发一个会话。** DSH 这边没有跨平台投递层，一条提醒只会落进最近说话的那个会话。会话解析不出、被委派子会话占用、`flush` 没回执——一律当失败，不重试、不攒着事后补发。

**`createUserMessage` 有兜底，两者不等价。** 优先 `import('@deepseek-ai/dsh-llm')` 拿宿主的工厂函数（生成稳定 id、冻结消息）；解析不到就手写等价结构。真机走的是手写那条路，能落盘，但没有宿主侧的冻结与去重语义。

**工具的 schema 是受限方言。** `parameters` 必须是完整 JSON Schema（`{type:"object", properties, required}`），因为 `tools.register` 不编译它；`output.schema` 里 `object` 节点要显式给 `additionalProperties`，属性上不能挂 `required`，也没有 `json` 这个类型名。外部插件拿不到 `defineTool` 的归一化，只能自己写对。

**判「是不是人话」看来源不看正文。** 真人 `source.kind === "user"`；系统有 `runtime-context`、`time-context`、`skill-catalog`、`model-selection`；插件自己是 `proactive-heartbeat`。正文前缀不可靠——模型切换通知就是一句干净的 `[model changed: …]`，没有任何系统前缀。

**心跳靠进程活着。** 宿主退出即停，没有守护。`tick_seconds` 到点才判，`first_delay_seconds` 只管启动后第一次。

---

## 卸载

```bash
dsh plugin remove dsh-proactive-heartbeat
```

账本不会自动删。要一并清掉：

```bash
rm -rf ~/.dsh/proactive-heartbeat
```

---

## 许可

MIT。

判断逻辑不依赖任何外部服务，不联网，不收集任何东西。账本只在本机，内容由你自己说的那些话组成。
