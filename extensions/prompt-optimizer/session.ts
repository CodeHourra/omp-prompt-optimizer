// One /optimize run: the generated versions and the generation in flight.
// No host imports at runtime, so the flow is testable with `bun test`.

import type { DiffChange } from "@oh-my-pi/pi-natives";

export type Generate = (onText: (text: string) => void, signal: AbortSignal) => Promise<string>;

/** How the panel closed: writing back needs both the text and the intent. */
export type Outcome = { kind: "accept" | "edit"; text: string } | undefined;

export class OptimizeSession {
  readonly original: string;
  /** Finished versions, oldest first. */
  readonly candidates: string[] = [];
  /** Selected version; -1 until the first one finishes. */
  index = -1;
  /** Text of the generation in flight. */
  partial = "";
  /** Last generation failure, cleared when the next one starts. */
  error = "";
  onChange: (() => void) | undefined;
  readonly #generate: Generate;
  #controller: AbortController | undefined;

  constructor(original: string, generate: Generate) {
    this.original = original;
    this.#generate = generate;
  }

  get streaming(): boolean {
    return this.#controller !== undefined;
  }

  /** The in-flight text while streaming, else the selected version. */
  get text(): string {
    return this.streaming ? this.partial : (this.candidates[this.index] ?? "");
  }

  /** Generate a new version and select it. No-op while one is in flight. */
  async generate(): Promise<void> {
    if (this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.partial = "";
    this.error = "";
    this.onChange?.();
    // A cancelled run already reset the state; its late results must not land.
    const current = () => this.#controller === controller;
    try {
      const text = await this.#generate((partial) => {
        if (!current()) return;
        this.partial = partial;
        this.onChange?.();
      }, controller.signal);
      if (!current()) return;
      this.candidates.push(text);
      this.index = this.candidates.length - 1;
    } catch (err) {
      if (!current()) return;
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.#controller = undefined;
    this.partial = "";
    this.onChange?.();
  }

  /** Abort the generation in flight; the selected version stays. */
  cancel(): void {
    const controller = this.#controller;
    if (!controller) return;
    this.#controller = undefined;
    this.partial = "";
    controller.abort();
    this.onChange?.();
  }

  select(delta: number): void {
    if (this.streaming || this.candidates.length === 0) return;
    const next = Math.min(Math.max(this.index + delta, 0), this.candidates.length - 1);
    if (next === this.index) return;
    this.index = next;
    this.onChange?.();
  }
}

export interface SessionUI {
  /** Show the panel until it closes. */
  show(session: OptimizeSession): Promise<Outcome>;
  /** Edit `text` in a dialog; undefined when cancelled. */
  edit(text: string): Promise<string | undefined>;
}

/**
 * Run the panel until the user settles: the text for the editor, or undefined
 * to keep the original. A cancelled or emptied edit returns to the panel with
 * every version intact.
 */
export async function runSession(session: OptimizeSession, ui: SessionUI): Promise<string | undefined> {
  void session.generate();
  for (;;) {
    const outcome = await ui.show(session);
    if (!outcome) {
      session.cancel();
      return undefined;
    }
    if (outcome.kind === "accept") return outcome.text;
    const edited = await ui.edit(outcome.text);
    if (edited?.trim()) return edited;
  }
}

/**
 * omp's compact diff text (`-1|old`, `+1|new`, ` 2|same`) for line changes:
 * removed and context rows carry old line numbers, added rows new ones.
 */
export function formatDiff(changes: readonly DiffChange[]): string {
  const rows: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of changes) {
    for (const line of change.value.replace(/\n$/, "").split("\n")) {
      if (change.added) rows.push(`+${newLine++}|${line}`);
      else if (change.removed) rows.push(`-${oldLine++}|${line}`);
      else {
        rows.push(` ${oldLine++}|${line}`);
        newLine++;
      }
    }
  }
  return rows.join("\n");
}
