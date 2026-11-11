// prompt-optimizer extension for OMP (Oh My Pi).
//
// /optimize — rewrite the current editor draft with an LLM in an overlay
// panel. The draft is never touched until you accept the result.
//
// Design contract:
//   - Trigger: /optimize slash command, or Option+O in the editor.
//   - Optimizer model: @smol role via ctx.models.resolve (zero plugin config).
//   - Context: last 3 conversation turns appended to the optimization request.
//   - View: host OverlayPanel + Markdown in a ScrollView; describe() gives Tern
//     a native sheet instead of the row fallback.
//   - Keys while streaming: interrupt key (Esc) / Ctrl+C aborts the request.
//   - Keys when done: Enter accept, r regenerate, e edit, ↑↓/PgUp/PgDn/Home/End
//     scroll, interrupt key keeps the original.
//   - Result: written to the editor only on accept / edit; never auto-sent.
//   - State: in-memory only. No history, no persistence.
//   - Fail fast: empty editor / no model / no auth / busy -> notify and exit.

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
import { boundKeys, interruptKey, OverlayPanel, PanelDivider } from "@oh-my-pi/pi-tui/chrome";
import { matchesAppInterrupt } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { hintsRow, type NativeHint } from "@oh-my-pi/pi-tui/native/overlay";
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
  tui: TUI;
  done: (outcome: Outcome) => void;
  run: (onText: (text: string) => void, signal: AbortSignal) => Promise<string>;
}

const ROLE = "omp.overlay.prompt-optimizer";

class OptimizerView extends OverlayPanel {
  // Tern draws an `omp.overlay.*` overlay as a glass sheet, so describe() must not add its own frame.
  readonly nativeOverlay = { role: ROLE };
  #deps: ViewDeps;
  #phase: "streaming" | "done" | "error" = "streaming";
  #text = "";
  #message = "";
  #frame = 0;
  #controller: AbortController | null = null;
  #disposed = false;
  #native: NativeNode | undefined;
  readonly #markdown = new Markdown("", 0, 0, getMarkdownTheme());
  readonly #notice = new Text("", 0, 0);
  readonly #scroll = new ScrollView(this.#notice, { height: 1, followTail: true });
  readonly #footer = new Text("", 0, 0);

  constructor(deps: ViewDeps) {
    super("", ROLE);
    this.#deps = deps;
    this.addChild(this.#scroll);
    this.addChild(new PanelDivider());
    this.addChild(this.#footer);
    this.#sync();
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
    this.#sync();
    const controller = new AbortController();
    this.#controller = controller;
    const timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length;
      this.#syncTitle();
      this.#deps.tui.requestRender();
    }, 120);
    try {
      const text = await this.#deps.run((partial) => {
        this.#text = partial;
        this.#sync();
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
      this.#sync();
    }
  }

  /** Push the phase and text into the child components, drop the native memo, repaint. */
  #sync(): void {
    this.#syncTitle();
    if (this.#phase === "error") {
      this.#notice.setText(theme.fg("error", this.#message));
      this.#scroll.setChild(this.#notice);
    } else if (this.#text) {
      this.#markdown.setText(this.#text);
      this.#scroll.setChild(this.#markdown);
    } else {
      this.#notice.setText(theme.fg("dim", `${theme.status.pending} 等待模型输出…`));
      this.#scroll.setChild(this.#notice);
    }
    this.#scroll.setFollowTail(this.#phase === "streaming");
    this.#footer.setText(this.#footerLine());
    this.#native = undefined;
    this.#deps.tui.requestRender();
  }

  #syncTitle(): void {
    const status =
      this.#phase === "streaming"
        ? `${FRAMES[this.#frame]} 优化中`
        : this.#phase === "error"
          ? `${theme.status.error} 优化失败`
          : `${theme.status.success} 已生成`;
    this.title = `${status} · ${this.#deps.label}`;
  }

  #footerLine(): string {
    const esc = interruptKey();
    if (this.#phase === "streaming") return theme.fg("muted", `${esc} 取消 · ↑↓ 滚动`);
    if (this.#phase === "error") return theme.fg("muted", `${esc} / ${formatKeyHint("enter")} 关闭`);
    const actions = [
      `${formatKeyHint("enter")} 接受`,
      `${formatKeyHint("r")} 再生成`,
      `${formatKeyHint("e")} 编辑`,
      "↑↓ 滚动",
      `${esc} 保留原文`,
    ];
    return theme.fg("muted", actions.join(" · "));
  }

  handleInput(data: string): void {
    const interrupt = matchesAppInterrupt(data) || matchesKey(data, "ctrl+c");
    if (this.#phase === "streaming") {
      if (interrupt) this.#controller?.abort();
      else if (this.#scroll.handleScrollKey(data)) this.#deps.tui.requestRender();
      return;
    }
    if (this.#phase === "error") {
      if (interrupt || matchesKey(data, "enter")) this.#deps.done(undefined);
      return;
    }
    if (interrupt) {
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
      return;
    }
    if (this.#scroll.handleScrollKey(data)) this.#deps.tui.requestRender();
  }

  override render(width: number): readonly string[] {
    // The overlay is clipped at the terminal height, so size the viewport to
    // what fits around the panel chrome: two borders, the divider, the footer.
    const inner = Math.max(1, width - 4);
    const body = this.#phase !== "error" && this.#text ? this.#markdown : this.#notice;
    const cap = Math.max(3, this.#deps.tui.terminal.rows - 3 - this.#footer.render(inner).length);
    this.#scroll.setHeight(Math.max(1, Math.min(body.render(inner).length, cap)));
    return super.render(width);
  }

  override describe(): NativeNode {
    if (this.#native) return this.#native;
    const live = this.#phase === "streaming";
    const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
      ...(live ? [node("spinner", {})] : []),
      text([span("/optimize", "accent"), span(` · ${this.#deps.label}`, "muted")], { truncate: "end", lines: 1 }),
    ]);
    const body =
      this.#phase === "error"
        ? text([span(this.#message, "error")], { wrap: "word" })
        : this.#text
          ? md(this.#text, { stream: live })
          : text([span(`${theme.status.pending} 等待模型输出…`, "dim")]);
    const esc = boundKeys("app.interrupt", ["escape"]).slice(0, 1);
    const hints: NativeHint[] = live
      ? [{ keys: esc, label: "取消" }]
      : this.#phase === "error"
        ? [{ keys: esc, label: "关闭" }]
        : [
            { keys: ["enter"], label: "接受" },
            { keys: ["r"], label: "再生成" },
            { keys: ["e"], label: "编辑" },
            { keys: esc, label: "保留原文" },
          ];
    this.#native = col([head, body, hintsRow(hints)], {
      gap: "sm",
      tone: this.#phase === "error" ? "error" : undefined,
    });
    return this.#native;
  }

  override invalidate(): void {
    this.#native = undefined;
    super.invalidate();
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller?.abort();
    super.dispose();
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
      factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component,
      options?: { overlay?: boolean },
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
        tui,
        done,
        run: (onText, signal) => generate(original, contextBlock, model, apiKey, signal, onText),
      });
      view.start();
      return view;
    }, { overlay: true });

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
