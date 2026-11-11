# omp-prompt-optimizer

Oh My Pi (omp) 扩展：`/optimize` 用 LLM 优化输入框里的提示词。

## 安装

把 `extensions/prompt-optimizer.ts` 复制到 `~/.omp/agent/extensions/`，重启 omp。

## 用法

- `/optimize <提示词>`：直接优化参数文本。
- 输入框已有内容时运行 `/optimize`：优化输入框内容。
- `Option+O`（或 `Alt+O`）：优化输入框当前内容。

生成期间浮条实时显示生成文本末尾；按 `Esc` 取消。生成结束后弹出编辑框显示结果：
Submit 写回输入框（不自动发送），Cancel 放弃。

## 模型

使用 `@smol` 角色模型；未配置时回退到第一个已认证模型。

## 已知限制

- 浮条是单行，只显示生成文本末尾约 120 个字符。
- 编辑框只有 Submit / Cancel 两个按钮，无法放置重新生成、查看原始等操作。
- `setWorkingMessage` 与 `notify` 在 Tern 中的表现未经验证。
