// prompt-optimizer extension for OMP (Oh My Pi).
//
// /optimize — rewrite the current editor draft with an LLM in a full-screen
// custom view. The draft is never touched until you accept the result.
//
// Design contract:
//   - Trigger: /optimize slash command, or Option+O in the editor.
//   - Optimizer model: @smol role via ctx.models.resolve (zero plugin config).
//   - Context: last 3 conversation turns appended to the optimization request.
//   - Keys while streaming: Esc / Ctrl+C aborts the request.
//   - Keys when done: Enter accept, r regenerate, e edit, Esc keep original.
//   - Result: written to the editor only on accept / edit; never auto-sent.
//   - State: in-memory only. No history, no persistence.
//   - Fail fast: empty editor / no model / no auth / busy -> notify and exit.

import type { Component } from "@oh-my-pi/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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
function collectRecentTurns(sessionManager: unknown): string {
  let branch: unknown[] = [];
  try {
    const sm = sessionManager as { getBranch?: () => unknown[] } | null;
    const entries = sm?.getBranch?.();
    if (Array.isArray(entries)) branch = entries;
  } catch {
    branch = [];
  }

  const parts: string[] = [];
  let turns = 0;
  for (let i = branch.length - 1; i >= 0 && turns < CONTEXT_TURNS; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof entry.message.content === "string"
      ? entry.message.content
      : Array.isArray(entry.message.content)
        ? (entry.message.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : "";
    if (!text.trim()) continue;
    if (role === "user") turns++;
    parts.push(`${role === "user" ? "User" : "Assistant"}: ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`);
  }
  // Restore chronological order.
  parts.reverse();
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface StreamMessage {
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

/** Run one optimization pass and return the full rewritten prompt. Throws on failure or abort. */
async function generate(
  original: string,
  contextBlock: string,
  model: unknown,
  apiKey: unknown,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  const messages = [
    {
      role: "user",
      content:
        `Rewrite the following draft prompt according to your instructions.${contextBlock}\n\n<draft-prompt>\n${original}\n</draft-prompt>`,
      timestamp: Date.now(),
    },
  ];

  const stream = streamSimple(
    model as never,
    { systemPrompt: [SYSTEM_PROMPT], messages },
    { apiKey, maxTokens: MAX_TOKENS, disableReasoning: true, signal },
  ) as unknown as AsyncIterable<{ type?: string; delta?: string }> & {
    result: () => Promise<StreamMessage>;
  };

  // Esc must end the wait even if the provider keeps the stream open after abort.
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => rejectAborted(new Error("已取消")), { once: true });
  let streamed = "";
  const consume = (async () => {
    for await (const event of stream) {
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        streamed += event.delta;
        onText(streamed);
      }
    }
  })();
  await Promise.race([consume, aborted]);
  if (signal.aborted) throw new Error("已取消");
  const result = await stream.result();
  if (result?.stopReason === "error") throw new Error(result.errorMessage || "优化模型返回错误");

  const finalText =
    streamed.trim() ||
    (result?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  if (!finalText) throw new Error("优化模型未返回内容");
  return finalText;
}

// ---------------------------------------------------------------------------
// Custom view
// ---------------------------------------------------------------------------

/** Resolution of the view: writing back needs both the text and the intent. */
type Outcome = { kind: "accept" | "edit"; text: string } | undefined;

interface ViewDeps {
  label: string;
  requestRender: () => void;
  done: (outcome: Outcome) => void;
  run: (onText: (text: string) => void, signal: AbortSignal) => Promise<string>;
}

class OptimizerView implements Component {
  #deps: ViewDeps;
  #phase: "streaming" | "done" | "error" = "streaming";
  #text = "";
  #message = "";
  #frame = 0;
  #controller: AbortController | null = null;
  #disposed = false;

  constructor(deps: ViewDeps) {
    this.#deps = deps;
  }

  /** Kick off the first generation. Call after the view is mounted. */
  start(): void {
    void this.#run();
  }

  async #run(): Promise<void> {
    this.#phase = "streaming";
    this.#text = "";
    this.#message = "";
    this.#frame = 0;
    const controller = new AbortController();
    this.#controller = controller;
    const timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length;
      this.#deps.requestRender();
    }, 120);
    try {
      const text = await this.#deps.run((partial) => {
        this.#text = partial;
        this.#deps.requestRender();
      }, controller.signal);
      this.#text = text;
      this.#phase = "done";
    } catch (err) {
      if (controller.signal.aborted) {
        // The draft was never touched; closing the view is the whole revert.
        this.#deps.done(undefined);
        return;
      }
      this.#message = err instanceof Error ? err.message : String(err);
      this.#phase = "error";
    } finally {
      clearInterval(timer);
      this.#controller = null;
      this.#deps.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.#phase === "streaming") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.#controller?.abort();
      }
      return;
    }
    if (this.#phase === "error") {
      if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) {
        this.#deps.done(undefined);
      }
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.#deps.done(undefined);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.#deps.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.#deps.done({ kind: "accept", text: this.#text });
      return;
    }
    if (data === "r" || data === "R") {
      void this.#run();
      return;
    }
    if (data === "e" || data === "E") {
      this.#deps.done({ kind: "edit", text: this.#text });
    }
  }

  render(width: number): string[] {
    // `width` is already the paint area the host reserved for this component;
    // `rows` bounds how many lines can be shown before the view is clipped.
    const w = Math.max(20, width);
    const rows = process.stdout.rows ?? 40;
    const spinner = FRAMES[this.#frame];
    const head =
      this.#phase === "streaming"
        ? `${spinner} 优化中（via ${this.#deps.label}）`
        : this.#phase === "error"
          ? `✗ 优化失败`
          : `✓ 已生成（via ${this.#deps.label}）`;
    const footer =
      this.#phase === "streaming"
        ? "Esc / Ctrl+C 取消"
        : this.#phase === "error"
          ? `${this.#message} — Enter / Esc 关闭`
          : "Enter 接受 · r 再生成 · e 编辑 · Esc 回退原文";

    // Wrap to the full width and do not add our own indent: the host already
    // pads the component, and any extra column pushes the last glyph off.
    const wrapped =
      this.#phase === "streaming" && !this.#text
        ? ["（等待模型输出…）"]
        : wrapTextWithAnsi(this.#text, w);

    // Reserve room for the header, both rules, the footer, and a chrome row.
    const chrome = this.#phase === "streaming" || this.#phase === "error" ? 5 : 4;
    const capacity = Math.max(3, rows - chrome);
    // When clipped, the notice takes one row and the newest lines fill the rest.
    const shown = wrapped.length > capacity ? wrapped.slice(-(capacity - 1)) : wrapped;
    const body =
      shown.length < wrapped.length ? [`… 上方 ${wrapped.length - shown.length} 行未显示`, ...shown] : shown;

    return [
      truncateToWidth(head, w),
      "─".repeat(w),
      ...body,
      "─".repeat(w),
      truncateToWidth(footer, w),
    ];
  }

  invalidate(): void {
    // No cached layout.
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller?.abort();
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

interface ModelLike {
  provider: string;
  id: string;
}

interface CommandCtx {
  hasUI: boolean;
  isIdle: () => boolean;
  sessionManager: unknown;
  modelRegistry: unknown;
  models?: { resolve?: (spec: string) => unknown; list?: () => unknown[] };
  ui: {
    getEditorText?: () => string;
    setEditorText?: (text: string) => void;
    notify: (message: string, kind?: "info" | "warning" | "error") => void;
    onTerminalInput?: (handler: (data: string) => { consume: boolean } | undefined) => () => void;
    custom?: <T>(
      factory: (tui: { requestRender: () => void }, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component,
    ) => Promise<T>;
  };
}

export default function promptOptimizer(pi: ExtensionAPI): void {
  pi.setLabel("Prompt Optimizer");
  let optimizing = false;

  // Shared entry: resolve draft text, then run the optimize interaction loop.
  // `fromShortcut` marks the trigger path where the editor draft is the input
  // (a shortcut fires with the draft still in the editor, unlike a slash
  // command, which needs an empty editor).
  const runOptimize = async (ctx: CommandCtx, argText: string, fromShortcut: boolean): Promise<void> => {
    if (!ctx.hasUI) return;

    const draft = argText || (ctx.ui.getEditorText?.() ?? "").trim();
    if (!draft) {
      ctx.ui.notify(
        fromShortcut ? "输入框为空：先写下要优化的提示词" : "用法：/optimize <要优化的提示词>（或在输入框写下内容后运行）",
        "warning",
      );
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("请等待当前回复完成后再优化", "warning");
      return;
    }

    // Optimizer model: @smol role, fall back to the first available model.
    let model: unknown = ctx.models?.resolve?.("@smol");
    if (!model) model = (ctx.models?.list?.() ?? [])[0];
    const modelLike = model as ModelLike | undefined;
    if (!modelLike) {
      ctx.ui.notify("没有可用的优化模型（@smol 未配置且无已认证模型）", "error");
      return;
    }
    const modelLabel = `${modelLike.provider}/${modelLike.id}`;

    const registry = ctx.modelRegistry as {
      hasConfiguredAuth?: (m: unknown) => boolean;
      getApiKey?: (m: unknown, sessionId?: string) => Promise<string | undefined>;
      resolver?: (m: unknown, sessionId?: string) => (opts?: unknown) => Promise<string | undefined>;
    } | undefined;
    if (registry?.hasConfiguredAuth && !registry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`优化模型 ${modelLabel} 没有可用凭据`, "error");
      return;
    }
    const sessionId = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
    const apiKeyResolver = registry?.resolver?.(model, sessionId);
    const apiKey =
      apiKeyResolver ??
      (registry?.getApiKey ? await registry.getApiKey(model, sessionId) : undefined);
    if (!apiKey) {
      ctx.ui.notify(`优化模型 ${modelLabel} 无法解析凭据`, "error");
      return;
    }

    const turns = collectRecentTurns(ctx.sessionManager);
    const contextBlock = turns ? `\n\n<recent-conversation>\n${turns}\n</recent-conversation>` : "";
    const original = draft;

    if (!ctx.ui.custom) {
      ctx.ui.notify("/optimize 需要交互式界面（custom UI 不可用）", "error");
      return;
    }

    const outcome = await ctx.ui.custom<Outcome>((tui, _theme, _keybindings, done) => {
      const view = new OptimizerView({
        label: modelLabel,
        requestRender: () => tui.requestRender(),
        done,
        run: (onText, signal) => generate(original, contextBlock, model, apiKey, signal, onText),
      });
      view.start();
      return view;
    });

    // Every non-accept exit puts the draft back: `/optimize <text>` clears the
    // editor before we run, so leaving without a write would lose the prompt.
    if (outcome === undefined) {
      ctx.ui.setEditorText?.(original);
      return;
    }
    ctx.ui.setEditorText?.(outcome.text);
    if (outcome.kind === "edit") ctx.ui.notify("已写入输入框，可编辑后发送", "info");
  };

  const optimizeOnce = async (ctx: CommandCtx, argText: string, fromShortcut: boolean): Promise<void> => {
    if (optimizing) {
      ctx.ui.notify("正在优化中：按 Esc 取消", "warning");
      return;
    }
    optimizing = true;
    try {
      await runOptimize(ctx, argText, fromShortcut);
    } finally {
      optimizing = false;
    }
  };

  pi.registerCommand("optimize", {
    description: "Optimize the current editor prompt with an LLM (pass text as argument, or run with an empty editor)",
    handler: async (args, ctx) => {
      const argText = typeof args === "string" ? args.trim() : "";
      await optimizeOnce(ctx as unknown as CommandCtx, argText, false);
    },
  });

  // Shortcut: Option/Alt+O optimizes the current editor draft.
  //
  // registerShortcut("alt+o") only fires for terminals that send the ESC+o
  // sequence; macOS Terminal.app and most Electron terminals send a
  // high-bit char (å, U+00E5) for Option+O instead, which the key parser
  // treats as text. We therefore intercept raw terminal input ourselves via
  // ui.onTerminalInput — it sees bytes before the editor and can consume
  // them — and recognize BOTH forms:
  //   - "å" (U+00E5)  — Option+O in high-bit mode (macOS default)
  //   - "\x1bo"        — Option+O in Esc-prefix mode (iTerm2 "Esc+", kitty,
  //                      Alacritty, WezTerm)
  // Kitty-protocol modifiers (\x1b[111;3u etc.) are left to the editor,
  // which would render å anyway when idle; the two forms above cover all
  // legacy terminals.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const remove = ctx.ui.onTerminalInput((data: string) => {
      if (data === "å" || data === "\x1bo") {
        void optimizeOnce(ctx as unknown as CommandCtx, "", true);
        return { consume: true };
      }
      return undefined;
    });
    pi.on("session_shutdown", () => remove());
  });
}
