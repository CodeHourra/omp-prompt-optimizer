# omp-prompt-optimizer

Oh My Pi (omp) 扩展：`/optimize` 用 LLM 优化输入框里的提示词。

## 安装

把 `extensions/prompt-optimizer.ts` 复制到 `~/.omp/agent/extensions/`，重启 omp。

## 用法

- `/optimize <提示词>`：优化参数文本。
- 输入框已有内容时运行 `/optimize`：优化输入框内容。

生成中：输入框上方的 widget 显示旋转帧与 `优化中 · Esc 取消`，输入框内容逐段被替换为已生成的文本。
生成结束：widget 移除，结果留在输入框中，不自动发送。按 `Esc` 取消生成。

## 模型

使用 `@smol` 角色模型；未配置时回退到第一个已认证模型。

## 已知限制

- 流式写入输入框依赖 `setEditorText` 高频调用，Tern 中的刷新表现未完全验证。
- 生成期间输入框会被覆盖，用户的输入会丢失。
- 取消后输入框保留的是取消时的部分结果，而不是原文。
