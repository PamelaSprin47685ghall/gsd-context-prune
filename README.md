# GSD Context Prune (上下文修剪插件)

`gsd-context-prune` 是一款为 GSD 极度精简重构的上下文管理插件。它以不到 300 行的原生无依赖 JavaScript 代码，解决了在长代理会话中因 `toolResult` 堆积导致的上下文爆满和 Prompt Cache 抖动问题。

## 核心特性：化繁为简的双层精简

### 1. 初级精简 (Primary Pruning) —— 按需折叠工具输出
插件会静默监听大模型的所有工具调用，并将那些庞大的 `toolResult` 提取出来放入缓存队列。
- 当大模型觉得自己需要“喘口气”，主动调用了无参数的 `context_prune` 工具时，插件就会在后台异步发送一个侧载 (Sidecar) LLM 请求。
- 后台 LLM 会将这批工具结果浓缩成一段精炼的摘要。
- 此后，在主代理请求上下文时，插件会在内存中把那些多余的 `toolResult` **幻影替换**成这条单薄的摘要（保留结构，缩减 Token）。主通道的执行永远不会被此后台进程阻塞。

### 2. 高级精简 (Global Summary) —— 满载态的世界线坍缩
- 插件在每个回合结束（`turn_end`）时计算上下文使用率。一旦超过 `66.66%`，初级精简已经不够看了，系统将触发“高级精简”。
- 插件把当前**已经打过初级补丁**的完整对话上下文送给伴随大模型，要求其只提炼“问题背景和当前进度”。
- 伴随大模型返回的结果，将作为一次**世界线坍缩**，在主代理的下一次对话中替换掉历史所有的消息（仅保留系统提示词和折叠后的状态点）。
- 主通道的代理对历史替换完全无感知：它依然认为自己在执行任务，但发给服务商的上下文包瞬间变回极度轻量的状态。

## 命令与持久化 (Commands & Persistence)

插件提供了一条直观的控制命令，供用户随时切换负责做总结的“伴车模型”：

```bash
/pruner anthropic/claude-haiku-3-5
```

如果缺省，将默认使用你当前主代理相同的模型。
你的选择会自动持久化保存到 `~/.gsd/context-prune.json` 中。所以只需配置一次，后续所有新的 GSD 会话和终端都会自动加载你最偏爱的伴车模型，彻底杜绝每次都需重设的繁琐。

## 安装

这是为 `pi-coding-agent` (GSD) 开发的非官方社区插件。进入 GSD 配置的插件目录中：

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

## 架构：少即是多

相较于被废弃的重度实现，该版本严格遵守：
- **无阻塞 (Zero-Block)**：伴随大模型请求失败、超时均不会阻断主进程的运转。
- **非破坏性投影 (Non-Destructive Projection)**：底层的核心历史永远是 Append-only 且真实的。压缩仅通过拦截 `context` 请求并施加幻影替换（投影）完成。
- **零复杂状态管理**：没有任何 Class 和状态机，跨 Session 持久化仅仅通过读取 `pi.appendEntry` 中的对象即完成复原。
- **尊重 Prompt Cache**：坚决避免像“每轮触发”这样高频破坏前缀缓存的逻辑，将折叠决策权交由大模型的内置逻辑或明确的阈值。

## 运行测试

只需安装 Node.js (>=20) ，即可运行零外部依赖的内建断言测试：

```bash
npm run test
# 或者: node --test index.test.mjs
```

```text
▶ gsd-context-prune
  ✔ registers all required events, tools, and commands (0.44ms)
  ✔ projects primary summaries and collapses context (0.27ms)
  ✔ does not trigger global summary on aborted or error stops (0.17ms)
  ✔ triggers global summary when usage exceeds 2/3 threshold (6.35ms)
✔ gsd-context-prune (8.48ms)
```

## 证书

MIT License
