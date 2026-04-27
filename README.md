# GSD Context Prune (上下文修剪 + 提示词注入插件)

`gsd-context-prune` 是一款为 GSD 极度精简重构的单文件插件。**内置集成了已废弃的 `gsd-hints-injector` 全部能力**，用户无需再单独安装 `gsd-hints-injector`。

它以不到 500 行的原生无依赖 JavaScript，解决两大问题：
- 长代理会话中 `toolResult` 堆积导致的上下文爆满
- 提示词缓存 (Prompt Cache) 命中率因动态内容下降

采用**一次成型**的对话结构，无需 `before_agent_start` 钩子或 custom 消息修补：

```
system(static) → user(dynamic context) → ai(收到) → user(real prompt) → ...
```

## 触发条件 (Trigger Conditions)

插件在以下几种时机自动或被动触发，通过 UI 通知让用户可见进度：

| 触发点 | 触发器 | 用户可见 | 行为 |
|---|---|---|---|
| **插件加载** | `session_start` | `pruner: 已加载。伴随模型 ...，会话摘要 N 条已恢复。` | 恢复跨会话摘要状态 |
| **初级精简** | 大模型主动调用 `context_prune` 工具 | `pruner: 开始精简 N 个工具调用...` → `pruner: 初级精简完成，工具输出已被折叠。` `[success]` | 后台 Sidecar LLM 浓缩最近一批工具调用的结果 |
| **初级精简（无任务）** | 大模型调用 `context_prune` 工具但队列为空 | `pruner: 当前无待精简的工具调用。` | 跳过，不浪费 Sidecar 调用 |
| **初级精简（忙碌）** | 上一轮尚未完成时新一轮触发 | `pruner: 上一轮精简仍在进行中，等待下一轮处理。` | 排队等待下次机会 |
| **高级精简** | `turn_end` 检测上下文使用率 > 2/3 | `pruner: 正在进行高级精简 (全局世界线坍缩)...` → `pruner: 高级精简完成，历史已被折叠。` `[success]` | 将全部对话历史摘要为"问题背景 + 当前进度"替换 |
| **高级精简（失败）** | Sidecar LLM 请求出错 | `pruner: 高级精简失败 - {错误信息}` | 保留原上下文，不坍缩 |

> **提示**: 初级精简依赖大模型在适当时机主动调用 `context_prune` 工具。建议在 system prompt 中提醒模型在完成一批工具调用后调用该工具。高级精简自动检测上下文压力，无需人工干预。

### 1. 双层上下文修剪 (Context Prune)

#### 初级精简 (Primary Pruning) —— 按需折叠工具输出
插件静默监听大模型的所有工具调用，并将庞大的 `toolResult` 提取到缓存队列。
- 当大模型主动调用无参数的 `context_prune` 工具时，插件在后台异步发送 Sidecar LLM 请求。
- 后台 LLM 将这批工具结果浓缩成摘要。
- 后续请求上下文时，多余的 `toolResult` 被**幻影替换**为单条摘要。

#### 高级精简 (Global Summary) —— 满载态的世界线坍缩
- 每个回合结束时计算上下文使用率。超过 **2/3 (66.66%)** 时触发高级精简。
- 插件把打过初级补丁的完整对话送给伴随 LLM，要求只提炼"问题背景和当前进度"。
- 伴随 LLM 的结果作为**世界线坍缩**替换所有历史消息。主代理对此完全无感知。

### 2. HINTS 注入（工具函数，无钩子）
将配置在 `~/.gsd/HINTS.md` 和项目级 `.gsd/HINTS.md`（或根目录 `HINTS.md`）中的系统提示词注入到 system prompt。

- `loadHintSources(cwd)` — 加载 HINTS 源
- `buildHintsBlock(cwd)` — 构建格式化 HINTS 块

上层调用者在构建 system prompt 时直接调用 `buildHintsBlock()` 将结果拼入即可，不涉及任何钩子或 custom 消息。

### 3. 稳定 Payload 标识符 & 实时 CODEBASE (Payload Stabilization)

插件在 `before_provider_request` 钩子中拦截所有 provider 的请求 payload，做三件事：

**a) System Prompt 静态化**
GSD 在 system prompt 中嵌入了 CODEBASE 地图，包含时间戳和文件指纹，每次刷新都会变化 → 前缀缓存必 miss。
插件从 system prompt 中剥离 CODEBASE 段，使 system prompt 变为完全静态。

**b) 实时文件列表注入（mimic `du -hxd1`，代替 GSD 的过期 CODEBASE）**
GSD 的 CODEBASE 经常过期（不主动更新），插件用自己的实现生成当前目录的实时文件列表：

```
$ du -hxd1
     260B  .git/
      42B  .gitignore
     4.0K  index.js
     1.2K  package.json
     574B  src/
```

格式复刻 `du -hxd1`：一行一个，`右对齐可读大小  名称`，目录名以 `/` 结尾，**目录的体积是递归总大小**。
当前目录因 `-d1` 不列出自身总行。列表注入到最后一条 user 消息的 `<system-notification>` 标签中。

**c) Provider 兼容性（消息规范化）**
- `content: null` → 自动修正为 `""`
- 当 `reasoning_effort` 启用时，缺失 `reasoning_content` 的 assistant 消息自动补 `""`

**d) Append-only 语义（缓存极致）**
每条 user 消息在它曾是最后一条的那个回合拿到自己的 notification，后续永不删改：

```
第 1 轮: sys → user("hello" + notif_1)
第 2 轮: sys → user("hello" + notif_1) → ai → user("more" + notif_2)
第 3 轮: sys → user("hello" + notif_1) → ai → user("more" + notif_2) → ai → user("again" + notif_3)
```

- system prompt 每轮都一样 → 前缀缓存命中
- 第 N-1 条 user 之前的历史完全不变 → 缓存命中
- 仅最后一条 user 变化（不可避免） + 实时文件列表
- 对 OpenAI Responses API 格式额外做 ID 稳定化（`msg_*` / `fc_*` / `call_*` 映射为连续递增）

## 提示词来源 (HINTS Sources)

1. **全局提示词**: `~/.gsd/HINTS.md` 或 `${GSD_HOME}/HINTS.md`
2. **项目级提示词**: 当前工作目录的 `.gsd/HINTS.md`（优先），不存在时回退至根目录 `HINTS.md`

## 命令与持久化 (Commands & Persistence)

```bash
/pruner anthropic/claude-haiku-3-5
```

切换负责总结的"伴车模型"。缺省时使用与主代理相同的模型。
选择持久化到 `~/.gsd/context-prune.json`，一次配置，所有会话生效。

## 安装

这是为 `pi-coding-agent` (GSD) 开发的社区插件。进入 GSD 配置的插件目录：

```bash
git clone https://github.com/your-username/gsd-context-prune.git
```

确保 `package.json` 包含如下挂载项：

```json
{
  "gsd": {
    "extension": true
  },
  "pi": {
    "extensions": ["index.js"]
  }
}
```

**注意**: `gsd-hints-injector` 的功能已合并至此插件。如果你之前安装了 `gsd-hints-injector`，请移除它，只保留 `gsd-context-prune` 即可。

## 架构：一次成型

相比旧方案（`before_agent_start` 剥离动态内容 → custom 消息 → 检测连续 user 消息 → 注入 assistant 回应），新方案遵循自然对话流程：

| 旧方案 | 新方案 |
|---|---|
| system prompt 混入动态内容 | system prompt 纯静态 |
| `before_agent_start` 剥离到 custom 消息 | 动态内容直接作为第一条 user 消息 |
| `context` 钩子检测修复连续消息 | 对话结构天然有序 |
| `fixConsecutiveUserMessages` 注入"收到" | AI 自然地回应上下文 |

新架构的事件线：
- `session_start` → 恢复跨会话状态
- `context` → 仅投影精简（无消息修复逻辑）
- `turn_end` → 捕获工具调用 + 监控上下文使用率
- `before_provider_request` → 仅稳定 Payload ID

## 运行测试

```bash
node --test index.test.mjs
```

预期输出（15 个测试全部通过）：

```
▶ ...
✔ registers all lifecycle hooks, tools, and commands (0.7ms)
✔ loadHintSources: loads global hints and prefers .gsd/HINTS.md (0.6ms)
✔ buildHintsBlock: returns empty string when no hints exist (0.3ms)
✔ buildHintsBlock: builds formatted hints block (0.4ms)
✔ stabilizes cache key and identifiers (0.4ms)
✔ projectMessages: passes through with no summaries (0.2ms)
✔ full integration: session_start restores persisted summaries (0.3ms)
✔ context hook does not inject assistant messages (one-shot pattern) (0.1ms)
...
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

## 证书

MIT License
