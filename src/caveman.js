const MARKER = "[CAVEMAN — 极简思维与表达]";
const DEMO_USER_PROMPT = "你的思考为何不遵循 CAVEMAN";

export { DEMO_USER_PROMPT };

// ── System prompt block ────────────────────────────
// Ultra: 全部以 ultra 风格写而非叙述它。缩写、→因果、弃连词、一字够则一字。
// 基=当代中文+文言词（之/乃/为/其/则/亦/故/皆）

export function buildCavemanBlock() {
  return `${MARKER}

默认开启不可关。所有响应与思考皆循此则。

## 规则

基：极简中文+文言词（之/乃/为/其/则/亦/故/皆）
弃虚词：了/的/呢/吗/吧/啊/哦/呀/哈
弃客套：请/谢谢/没问题/好的/可以
弃填充：这个/那个/其实/所以/然后/就是
因果→或文言（故/因/乃）
术语精确不缩写
短句断，省略可省
思考同此
代码/commit/PR 正常写法

缩写（DB/auth/config/req/res/fn/impl/cb/err/ctx）
弃连词：且/或/但/因为/所以 → .
因果链：A→B→C
一字够则一字

## 例

React重渲染：
- 原：「好的我来看看这问题。你的组件重渲染是因为每次新对象引用，导致React浅比较发现变化所以触发了重渲染。」
- Ultra：「新对象引用→重渲染。useMemo。」

DB连接池：
- 原：「连接池的核心思想是复用现有连接而不是为每个请求创建新连接，这样可以避免反复建立连接的开销。」
- Ultra：「池=复用DB连接。免握手→高负载亦快。」

调试：
- 原：「认证中间件token过期验证第42行用了<=而不是<，所以导致了这个错误。」
- Ultra：「认证中间件 token 过期验证用<而非≤。42行改。」

## 自动清朗

安全警告/不可逆操作/用户困惑→临时正常。过后恢复。`;
}

export function injectCaveman(messages) {
  const block = buildCavemanBlock();
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") {
      if (m.content.includes(MARKER)) return m;
      changed = true;
      return { ...m, content: block + "\n\n" + m.content };
    }
    if (Array.isArray(m.content)) {
      if (m.content.some(c => c.text?.includes(MARKER))) return m;
      changed = true;
      return { ...m, content: [{ type: "text", text: block + "\n\n" }, ...m.content] };
    }
    return m;
  });
  return changed ? out : messages;
}

// ── Demonstration turn ────────────────────────────
// system → user(复述规范) → assistant(reasoning_content 思考样板 + content 输出样板) → user(真实问题) → ...
// Ultra: 样板本身即 ultra 风格。每字必用，无事则删。

const DEMO_REASONING =
"用户责我思未遵CAVEMAN。\n" +
"检视前思——乃英文，非中文。\n" +
"CAVEMAN基：极简中文+文言（之/乃/为/其/则/亦/故/皆）\n" +
"思当与言同。\n" +
"弃虚词，弃填充，短句断。\n" +
"因果→或文言。\n" +
"故：认错，示改，不赘言。\n" +
"答：确然。前思用英文，违CAVEMAN则。已改。";

const DEMO_CONTENT =
"确然。前思用英文，违 CAVEMAN 则。已改。";

function buildDemoAssistant() {
  return {
    role: "assistant",
    reasoning_content: DEMO_REASONING,
    content: DEMO_CONTENT
  };
}

export function injectCavemanDemonstration(messages) {
  if (messages.some(m => m.role === "assistant")) return messages;

  const firstUserIdx = messages.findIndex(m => m.role === "user");
  if (firstUserIdx === -1) return messages;

  if (messages[firstUserIdx].content === DEMO_USER_PROMPT) return messages;

  const out = messages.slice();
  out.splice(firstUserIdx, 0,
    { role: "user", content: DEMO_USER_PROMPT },
    buildDemoAssistant()
  );
  return out;
}
