import { describe, expect, test } from "bun:test";
import { formatDiff, type Generate, OptimizeSession, type Outcome, runSession, type SessionUI } from "./session";

/** Lets pending generations settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Each call returns the next reply; `null` hangs until aborted, an Error rejects. */
function scripted(...replies: (string | Error | null)[]): Generate & { calls: number } {
  const fn = Object.assign(
    async (onText: (text: string) => void, signal: AbortSignal): Promise<string> => {
      const reply = replies[fn.calls++];
      if (reply === null || reply === undefined) {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("已取消"))));
      }
      if (reply instanceof Error) throw reply;
      onText(reply.slice(0, 1));
      return reply;
    },
    { calls: 0 },
  );
  return fn;
}

/** A panel that plays one step per mount; each step sees the settled session. */
function panel(
  steps: ((session: OptimizeSession) => Outcome | Promise<Outcome>)[],
  edits: (string | undefined)[] = [],
): SessionUI & { mounts: number } {
  const ui = {
    mounts: 0,
    async show(session: OptimizeSession) {
      await tick();
      return steps[ui.mounts++]!(session);
    },
    async edit() {
      return edits.shift();
    },
  };
  return ui;
}

describe("runSession", () => {
  test("accept returns the generated version", async () => {
    const generate = scripted("v1");
    const session = new OptimizeSession("draft", generate);
    const result = await runSession(session, panel([(s) => ({ kind: "accept", text: s.text })]));
    expect(result).toBe("v1");
    expect(generate.calls).toBe(1);
  });

  test("closing during the first generation aborts it and keeps the original", async () => {
    let signal: AbortSignal | undefined;
    const session = new OptimizeSession("draft", (_onText, s) => {
      signal = s;
      return new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("已取消"))));
    });
    const result = await runSession(session, panel([() => undefined]));
    expect(result).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(session.streaming).toBe(false);
  });

  test("regenerating keeps earlier versions selectable", async () => {
    const session = new OptimizeSession("draft", scripted("v1", "v2"));
    const result = await runSession(
      session,
      panel([
        async (s) => {
          await s.generate();
          expect(s.candidates).toEqual(["v1", "v2"]);
          expect(s.text).toBe("v2");
          s.select(-1);
          s.select(-1);
          return { kind: "accept", text: s.text };
        },
      ]),
    );
    expect(result).toBe("v1");
  });

  test("a cancelled edit returns to the panel without regenerating; a saved edit wins", async () => {
    const generate = scripted("v1");
    const ui = panel(
      [(s) => ({ kind: "edit", text: s.text }), (s) => ({ kind: "edit", text: s.text })],
      [undefined, "edited"],
    );
    const result = await runSession(new OptimizeSession("draft", generate), ui);
    expect(result).toBe("edited");
    expect(ui.mounts).toBe(2);
    expect(generate.calls).toBe(1);
  });

  test("an emptied edit is treated as cancelled", async () => {
    const ui = panel(
      [(s) => ({ kind: "edit", text: s.text }), () => undefined],
      ["   "],
    );
    expect(await runSession(new OptimizeSession("draft", scripted("v1")), ui)).toBeUndefined();
    expect(ui.mounts).toBe(2);
  });
});

describe("OptimizeSession", () => {
  test("a failure without versions surfaces the error; retry clears it", async () => {
    const session = new OptimizeSession("draft", scripted(new Error("boom"), "v1"));
    await session.generate();
    expect(session.error).toBe("boom");
    expect(session.candidates).toEqual([]);
    await session.generate();
    expect(session.error).toBe("");
    expect(session.text).toBe("v1");
  });

  test("cancelling a regeneration keeps the selected version and drops the late result", async () => {
    let finish: ((text: string) => void) | undefined;
    let calls = 0;
    const session = new OptimizeSession("draft", async () => {
      if (calls++ === 0) return "v1";
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    await session.generate();
    const second = session.generate();
    expect(session.streaming).toBe(true);
    session.cancel();
    expect(session.streaming).toBe(false);
    expect(session.text).toBe("v1");
    finish?.("late");
    await second;
    expect(session.candidates).toEqual(["v1"]);
  });

  test("select clamps at both ends", async () => {
    const session = new OptimizeSession("draft", scripted("v1", "v2"));
    await session.generate();
    await session.generate();
    session.select(5);
    expect(session.index).toBe(1);
    session.select(-5);
    expect(session.index).toBe(0);
  });
});

describe("formatDiff", () => {
  test("numbers removed/context rows by old lines and added rows by new lines", () => {
    const changes = [
      { value: "keep\n", count: 1, added: false, removed: false },
      { value: "old a\nold b\n", count: 2, added: false, removed: true },
      { value: "new a\n", count: 1, added: true, removed: false },
      { value: "tail", count: 1, added: false, removed: false },
    ];
    expect(formatDiff(changes)).toBe([" 1|keep", "-2|old a", "-3|old b", "+2|new a", " 4|tail"].join("\n"));
  });
});
