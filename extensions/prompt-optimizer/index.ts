// prompt-optimizer extension for OMP (Oh My Pi).
//
// /optimize — rewrite the current editor draft with an LLM in an overlay
// panel. The draft is never touched until you accept the result.
//
// Design contract:
//   - Trigger: /optimize slash command, TUI mode only.
//   - Optimizer model: @smol role via ctx.models.resolve (zero plugin config).
//   - Context: last 3 conversation turns appended to the optimization request.
//   - View: host OverlayPanel + Markdown in a ScrollView; describe() gives Tern
//     a native sheet. Versions and the generation in flight live in
//     OptimizeSession (session.ts).
//   - Keys while streaming: interrupt key (Esc) / Ctrl+C cancels the request.
//   - Keys when done: Enter accept, r regenerate, e edit in a dialog,
//     ←/→ switch version, d diff against the original,
//     ↑↓/PgUp/PgDn/Home/End scroll, interrupt key keeps the original.
//   - Result: written to the editor only on accept / edit; never auto-sent.
//   - State: in-memory only; versions live until the panel closes.
//   - Fail fast: empty editor / no model / no auth / busy -> notify and exit.

import { type ApiKey, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import { diffLines } from "@oh-my-pi/pi-natives";
import {
  col,
  type Component,
  getMarkdownTheme,
  Markdown,
  matchesKey,
  md,
  type NativeNode,
  node,
  ScrollView,
  span,
  Text,
  text,
  theme,
  type TUI,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import {
  boundKeys,
  interruptKey,
  nativeDiff,
  OverlayPanel,
  PanelDivider,
  renderDiff,
} from "@oh-my-pi/pi-tui/chrome";
import { matchesAppInterrupt } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { hintsRow, type NativeHint, statusHintsRow } from "@oh-my-pi/pi-tui/native/overlay";
import { formatDiff, OptimizeSession, type Outcome, runSession } from "./session";

const SYSTEM_PROMPT = `You are a prompt engineering expert. Rewrite the user's draft prompt so an AI coding assistant can execute it precisely.
Rules:
- Clarify intent: turn vague statements into specific, actionable instructions.
- Complete context the user clearly implied (language/stack in use, target environment, constraints) — but NEVER invent requirements the user did not express.
- Structure: use short paragraphs or numbered points for multi-part requests; state the expected output format and acceptance criteria explicitly.
- Remove redundancy, filler, and ambiguity (resolve pronouns using the conversation context when provided).
- Output in the SAME language as the original draft prompt.
- Preserve the user's intent and tone. No moralizing, no meta commentary.
- Output ONLY the rewritten prompt. No preamble, no explanations, no markdown code fences.`;

const MAX_TOKENS = 4096;
const CONTEXT_TURNS = 3;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------------------
// Conversation context (last N turns)
// ---------------------------------------------------------------------------

/** Extract the last CONTEXT_TURNS user/assistant exchanges as plain text. */
function collectRecentTurns(sessionManager: ReadonlySessionManager): string {
  const branch = sessionManager.getBranch();
  const parts: string[] = [];
  let turns = 0;
  for (let i = branch.length - 1; i >= 0 && turns < CONTEXT_TURNS; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
    if (!text.trim()) continue;
    if (message.role === "user") turns++;
    parts.push(
      `${message.role === "user" ? "User" : "Assistant"}: ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`,
    );
  }
  // Restore chronological order.
  parts.reverse();
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Run one optimization pass and return the full rewritten prompt. Throws on failure or abort. */
async function generate(
  original: string,
  contextBlock: string,
  model: Model,
  apiKey: ApiKey,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  const stream = streamSimple(
    model,
    {
      systemPrompt: [SYSTEM_PROMPT],
      messages: [
        {
          role: "user",
          content: `Rewrite the following draft prompt according to your instructions.${contextBlock}\n\n<draft-prompt>\n${original}\n</draft-prompt>`,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: MAX_TOKENS, disableReasoning: true, signal },
  );

  // Esc must end the wait even if the provider keeps the stream open after abort.
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => rejectAborted(new Error("已取消")), { once: true });
  let streamed = "";
  const consume = (async () => {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        streamed += event.delta;
        onText(streamed);
      }
    }
  })();
  await Promise.race([consume, aborted]);
  if (signal.aborted) throw new Error("已取消");
  const result = await stream.result();
  if (result.stopReason === "error") throw new Error(result.errorMessage || "优化模型返回错误");

  const finalText =
    streamed.trim() ||
    result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
  if (!finalText) throw new Error("优化模型未返回内容");
  return finalText;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const ROLE = "omp.overlay.prompt-optimizer";

class OptimizerView extends OverlayPanel {
  // Tern draws an `omp.overlay.*` overlay as a glass sheet, so describe() must not add its own frame.
  readonly nativeOverlay = { role: ROLE };
  readonly #session: OptimizeSession;
  readonly #label: string;
  readonly #tui: TUI;
  readonly #done: (outcome: Outcome) => void;
  #diff = false;
  #diffText = "";
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #native: NativeNode | undefined;
  readonly #markdown = new Markdown("", 0, 0, getMarkdownTheme());
  readonly #plain = new Text("", 0, 0);
  #body: Component = this.#plain;
  readonly #scroll = new ScrollView(this.#plain, { height: 1, followTail: true });
  readonly #footer = new Text("", 0, 0);

  constructor(session: OptimizeSession, label: string, tui: TUI, done: (outcome: Outcome) => void) {
    super("", ROLE);
    this.#session = session;
    this.#label = label;
    this.#tui = tui;
    this.#done = done;
    this.addChild(this.#scroll);
    this.addChild(new PanelDivider());
    this.addChild(this.#footer);
    session.onChange = () => this.#sync();
    this.#sync();
  }

  #phase(): "streaming" | "error" | "done" {
    if (this.#session.streaming) return "streaming";
    return this.#session.candidates.length === 0 ? "error" : "done";
  }

  #version(): string {
    const { candidates, index } = this.#session;
    return candidates.length > 1 && !this.#session.streaming ? ` v${index + 1}/${candidates.length}` : "";
  }

  /** Push session state into the child components, drop the native memo, repaint. */
  #sync(): void {
    const session = this.#session;
    const phase = this.#phase();
    if (phase === "streaming" && !this.#timer) {
      this.#timer = setInterval(() => {
        this.#frame = (this.#frame + 1) % FRAMES.length;
        this.#syncTitle();
        this.#tui.requestRender();
      }, 120);
    } else if (phase !== "streaming" && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#diffText = phase === "done" && this.#diff ? formatDiff(diffLines(session.original, session.text)) : "";
    this.#syncTitle();
    if (phase === "error") {
      this.#plain.setText(theme.fg("error", session.error));
      this.#body = this.#plain;
    } else if (this.#diffText) {
      this.#plain.setText(renderDiff(this.#diffText));
      this.#body = this.#plain;
    } else if (session.text) {
      this.#markdown.setText(session.text);
      this.#body = this.#markdown;
    } else {
      this.#plain.setText(theme.fg("dim", `${theme.status.pending} 等待模型输出…`));
      this.#body = this.#plain;
    }
    this.#scroll.setChild(this.#body);
    this.#scroll.setFollowTail(phase === "streaming");
    this.#footer.setText(this.#footerLine());
    this.#native = undefined;
    this.#tui.requestRender();
  }

  #syncTitle(): void {
    const phase = this.#phase();
    const status =
      phase === "streaming"
        ? `${FRAMES[this.#frame]} 优化中`
        : phase === "error"
          ? `${theme.status.error} 优化失败`
          : `${theme.status.success} 已生成`;
    this.title = `${status}${this.#version()} · ${this.#label}`;
  }

  #footerLine(): string {
    const esc = interruptKey();
    const phase = this.#phase();
    if (phase === "streaming") return theme.fg("muted", `${esc} 取消 · ↑↓ 滚动`);
    if (phase === "error") return theme.fg("muted", `${formatKeyHint("r")} 重试 · ${esc} 关闭`);
    const actions = [
      `${formatKeyHint("enter")} 接受`,
      `${formatKeyHint("r")} 再生成`,
      `${formatKeyHint("e")} 编辑`,
      ...(this.#session.candidates.length > 1 ? ["←→ 切换版本"] : []),
      `${formatKeyHint("d")} ${this.#diff ? "看全文" : "对比原文"}`,
      "↑↓ 滚动",
      `${esc} 保留原文`,
    ];
    const line = theme.fg("muted", actions.join(" · "));
    // A failed regeneration keeps the selected version; say why nothing changed.
    const error = this.#session.error;
    return error ? `${theme.fg("error", `${theme.status.error} ${error}`)}\n${line}` : line;
  }

  handleInput(data: string): void {
    const session = this.#session;
    const phase = this.#phase();
    const interrupt = matchesAppInterrupt(data) || matchesKey(data, "ctrl+c");
    if (phase === "streaming") {
      if (interrupt) {
        session.cancel();
        if (session.candidates.length === 0) this.#done(undefined);
      } else if (this.#scroll.handleScrollKey(data)) this.#tui.requestRender();
      return;
    }
    if (interrupt) {
      this.#done(undefined);
      return;
    }
    if (data === "r" || data === "R") {
      this.#diff = false;
      void session.generate();
      return;
    }
    if (phase === "error") {
      if (matchesKey(data, "enter")) this.#done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.#done({ kind: "accept", text: session.text });
      return;
    }
    if (data === "e" || data === "E") {
      this.#done({ kind: "edit", text: session.text });
      return;
    }
    if (data === "d" || data === "D") {
      this.#diff = !this.#diff;
      this.#scroll.scrollToTop();
      this.#sync();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.#scroll.scrollToTop();
      session.select(matchesKey(data, "left") ? -1 : 1);
      return;
    }
    if (this.#scroll.handleScrollKey(data)) this.#tui.requestRender();
  }

  override render(width: number): readonly string[] {
    // The overlay is clipped at the terminal height, so size the viewport to
    // what fits around the panel chrome: two borders, the divider, the footer.
    const inner = Math.max(1, width - 4);
    const cap = Math.max(3, this.#tui.terminal.rows - 3 - this.#footer.render(inner).length);
    this.#scroll.setHeight(Math.max(1, Math.min(this.#body.render(inner).length, cap)));
    return super.render(width);
  }

  override describe(): NativeNode {
    if (this.#native) return this.#native;
    const session = this.#session;
    const phase = this.#phase();
    const live = phase === "streaming";
    const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
      ...(live ? [node("spinner", {})] : []),
      text([span("/optimize", "accent"), span(`${this.#version()} · ${this.#label}`, "muted")], {
        truncate: "end",
        lines: 1,
      }),
    ]);
    const body =
      phase === "error"
        ? text([span(session.error, "error")], { wrap: "word" })
        : this.#diffText
          ? nativeDiff(this.#diffText)
          : session.text
            ? md(session.text, { stream: live })
            : text([span(`${theme.status.pending} 等待模型输出…`, "dim")]);
    const esc = boundKeys("app.interrupt", ["escape"]).slice(0, 1);
    const hints: (NativeHint | undefined)[] = live
      ? [{ keys: esc, label: "取消" }]
      : phase === "error"
        ? [
            { keys: ["r"], label: "重试" },
            { keys: esc, label: "关闭" },
          ]
        : [
            { keys: ["enter"], label: "接受" },
            { keys: ["r"], label: "再生成" },
            { keys: ["e"], label: "编辑" },
            session.candidates.length > 1 ? { keys: ["left", "right"], label: "切换版本" } : undefined,
            { keys: ["d"], label: this.#diff ? "看全文" : "对比原文" },
            { keys: esc, label: "保留原文" },
          ];
    const footer =
      phase === "done" && session.error
        ? statusHintsRow([span(`${theme.status.error} ${session.error}`, "error")], hints)
        : hintsRow(hints);
    this.#native = col([head, body, footer], { gap: "sm", tone: phase === "error" ? "error" : undefined });
    return this.#native;
  }

  override invalidate(): void {
    this.#native = undefined;
    super.invalidate();
  }

  override dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#session.cancel();
    this.#session.onChange = undefined;
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function promptOptimizer(pi: ExtensionAPI): void {
  pi.setLabel("Prompt Optimizer");
  let optimizing = false;

  const runOptimize = async (ctx: ExtensionCommandContext, argText: string): Promise<void> => {
    // RPC/print hosts resolve custom() at once, which would read as a silent cancel.
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/optimize 仅支持交互式终端（TUI）", "warning");
      return;
    }

    const draft = argText || ctx.ui.getEditorText().trim();
    if (!draft) {
      ctx.ui.notify("用法：/optimize <要优化的提示词>（或在输入框写下内容后运行）", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("请等待当前回复完成后再优化", "warning");
      return;
    }

    // Optimizer model: @smol role, fall back to the first available model.
    const model = ctx.models.resolve("@smol") ?? ctx.models.list()[0];
    if (!model) {
      ctx.ui.notify("没有可用的优化模型（@smol 未配置且无已认证模型）", "error");
      return;
    }
    const modelLabel = `${model.provider}/${model.id}`;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`优化模型 ${modelLabel} 没有可用凭据`, "error");
      return;
    }
    const apiKey = ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId());

    const turns = collectRecentTurns(ctx.sessionManager);
    const contextBlock = turns ? `\n\n<recent-conversation>\n${turns}\n</recent-conversation>` : "";
    const session = new OptimizeSession(draft, (onText, signal) =>
      generate(draft, contextBlock, model, apiKey, signal, onText),
    );

    const final = await runSession(session, {
      show: () =>
        ctx.ui.custom<Outcome>((tui, _theme, _keybindings, done) => new OptimizerView(session, modelLabel, tui, done), {
          overlay: true,
        }),
      edit: (text) => ctx.ui.editor("编辑优化结果 · 保存写入输入框，取消返回面板", text),
    });

    // `/optimize <text>` clears the editor before we run, so every exit writes something back.
    ctx.ui.setEditorText(final ?? draft);
  };

  pi.registerCommand("optimize", {
    description: "Optimize the current editor prompt with an LLM (pass text as argument, or run with an empty editor)",
    handler: async (args, ctx) => {
      if (optimizing) {
        ctx.ui.notify("正在优化中：按 Esc 取消", "warning");
        return;
      }
      optimizing = true;
      try {
        await runOptimize(ctx, args.trim());
      } finally {
        optimizing = false;
      }
    },
  });
}
