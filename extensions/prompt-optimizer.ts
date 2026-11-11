// prompt-optimizer extension for OMP (Oh My Pi).
//
// /optimize — optimize the current editor draft with an LLM, then pick the
// result from a native dialog: accept, edit, view the original, regenerate,
// or keep the original draft.
//
// Design contract:
//   - Trigger: /optimize slash command, reads current editor text.
//   - Optimizer model: @smol role via ctx.models.resolve (zero plugin config).
//   - Context: last 3 conversation turns appended to the optimization request.
//   - Progress: working message while generating; Esc cancels the request.
//   - Result: written back to the input box after generation; never auto-sent.
//   - State: in-memory only. No history, no persistence.
//   - Fail fast: empty editor / no model / no auth / busy -> notify and exit.

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

  let streamed = "";
  for await (const event of stream) {
    if (event?.type === "text_delta" && typeof event.delta === "string") {
      streamed += event.delta;
      onText(streamed);
    }
  }
  const result = await stream.result();
  if (signal.aborted) throw new Error("已取消");
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
    setWidget?: (key: string, lines: string[] | undefined, opts?: { placement?: "aboveEditor" | "belowEditor" }) => void;
    onTerminalInput?: (handler: (data: string) => { consume: boolean } | undefined) => () => void;
  };
}

export default function promptOptimizer(pi: ExtensionAPI): void {
  pi.setLabel("Prompt Optimizer");

  /**
   * Run one generation with a working message and an Esc-to-cancel key.
   * Returns the text, or undefined when cancelled or failed (failures are notified).
   */
  const generateWithProgress = async (
    ctx: CommandCtx,
    label: string,
    original: string,
    contextBlock: string,
    model: unknown,
    apiKey: unknown,
  ): Promise<string | undefined> => {
    const controller = new AbortController();
    const removeKeys = ctx.ui.onTerminalInput?.((data) => {
      if (data === "\x1b") {
        controller.abort();
        return { consume: true };
      }
      return undefined;
    });
    const WIDGET = "prompt-optimizer";
    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const render = () => {
      ctx.ui.setWidget?.(WIDGET, [`${FRAMES[frame]} 优化中（via ${label}）· Esc 取消`], { placement: "aboveEditor" });
    };
    render();
    const timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      render();
    }, 150);
    // Each delta rewrites the input box with the text generated so far.
    const stream = (text: string) => {
      ctx.ui.setEditorText?.(text);
    };
    try {
      return await generate(original, contextBlock, model, apiKey, controller.signal, stream);
    } catch (err) {
      if (!controller.signal.aborted) {
        ctx.ui.notify(`优化失败：${err instanceof Error ? err.message : String(err)}`, "error");
      } else {
        ctx.ui.notify("已取消优化", "info");
      }
      return undefined;
    } finally {
      clearInterval(timer);
      removeKeys?.();
      ctx.ui.setWidget?.(WIDGET, undefined);
    }
  };

  // Shared entry: resolve draft text, then run the optimize interaction loop.
  // `fromShortcut` marks the trigger path where the editor draft is the input
  // (a shortcut fires with the draft still in the editor, unlike a slash
  // command, which needs an empty editor).
  const optimizeOnce = async (ctx: CommandCtx, argText: string, fromShortcut: boolean): Promise<void> => {
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
    const optimized = await generateWithProgress(ctx, modelLabel, original, contextBlock, model, apiKey);
    if (optimized === undefined) return;

    // Echo the result into the input box; the user reviews, edits, and sends.
    ctx.ui.setEditorText?.(optimized.trim());
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
