# omp-prompt-optimizer

Oh My Pi (omp) 扩展：`/optimize` 用 LLM 优化输入框里的提示词。

## 安装

**方式一：marketplace（推荐）**

```
/marketplace add CodeHourra/omp-prompt-optimizer
/marketplace install prompt-optimizer@omp-prompt-optimizer
```

安装后执行 `/reload-plugins` 或重启 omp。

**方式二：目录**

把 `extensions/prompt-optimizer/` 整个目录复制到 `~/.omp/agent/extensions/`，重启 omp。
两种方式只保留一种，同时安装会重复注册 `/optimize`。

## 用法

- `/optimize <提示词>`：优化参数文本。
- 输入框已有内容时运行 `/optimize`：优化输入框内容。

仅支持交互式终端（TUI）。生成中弹出浮层面板，按 Markdown 流式渲染结果，**输入框内容保持原文不动**。在 Tern 中显示为原生面板。

- `Esc`（omp 的中断键）/ `Ctrl+C`：取消生成；首次生成时回退原文，再生成时回到上一版。
- `↑↓` / `Shift+↑↓` / `PgUp` / `PgDn` / `Home` / `End`：滚动查看全文。
- 生成结束：
  - `Enter` 接受，写入输入框
  - `r` 再生成，之前的版本保留
  - `←` / `→` 切换版本
  - `d` 与原文逐行对比，再按一次回到全文
  - `e` 在编辑框里修改，保存后写入输入框；取消则回到面板
  - `Esc` 回退原文
- 出错时：`r` 重试 · `Esc` 关闭。

## 模型

使用 `@smol` 角色模型；未配置时回退到第一个已认证模型。

## 开发

```
bun test extensions/prompt-optimizer/session.test.ts
```

## 已知限制

- `/optimize` 进行中再次触发会被拦下，需先按 `Esc` 取消。
- 版本只保存在内存里，面板关闭后即丢弃。
