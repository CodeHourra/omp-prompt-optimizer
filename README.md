# omp-prompt-optimizer

Oh My Pi (omp) 扩展：`/optimize` 用 LLM 优化输入框里的提示词。

## 安装

**方式一：marketplace（推荐）**

```
/marketplace add CodeHourra/omp-prompt-optimizer
/marketplace install prompt-optimizer@omp-prompt-optimizer
```

安装后执行 `/reload-plugins` 或重启 omp。

**方式二：单文件**

把 `extensions/prompt-optimizer.ts` 复制到 `~/.omp/agent/extensions/`，重启 omp。
两种方式只保留一种，同时安装会重复注册 `/optimize`。

## 用法

- `/optimize <提示词>`：优化参数文本。
- 输入框已有内容时运行 `/optimize`：优化输入框内容。

生成中：进入全屏视图，显示旋转帧与已生成文本的末尾 14 行，**输入框内容保持原文不动**。
- `Esc` / `Ctrl+C`：取消生成，输入框仍是原文。
- 生成结束：`Enter` 接受写入输入框 · `r` 再生成 · `e` 编辑（同样写入输入框）· `Esc` 回退原文。

## 模型

使用 `@smol` 角色模型；未配置时回退到第一个已认证模型。

## 已知限制

- 全屏视图只显示最后 14 行，完整结果通过「接受」或「编辑」写入输入框。
- `/optimize` 进行中再次触发会被拦下，需先按 `Esc` 取消。
