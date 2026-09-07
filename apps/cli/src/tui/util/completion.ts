/**
 * Input completion, as a table of sources rather than one hardcoded `/` branch.
 *
 * Today the session registers one source: `/` over the command catalog, the agent registry and the
 * skill registry. The shape exists because the next ones are known and each should be an entry in
 * an array, not a second popup with its own keyboard handling — `@` over worktree paths, `#` over
 * memory, whatever follows. Everything that differs between them is a field below; everything they
 * share (find the token, match it, render it, replace it) is here and is written once.
 */

export type CompletionItem = {
  /** The text inserted when this item is chosen, trigger included — `/perf-review`, `@src/cli.ts`. */
  value: string;
  /** The right-hand column of the popup. One line; it is truncated, never wrapped. */
  description: string;
};

export type CompletionSource = {
  /** Names the source in code and in tests. Not shown to the user. */
  id: string;
  /** The single character that opens this source when it starts the token being typed. */
  trigger: string;
  /**
   * True when the trigger only means anything as the first character of the whole line. `/` is
   * such a source: a `/` in the middle of a sentence is a path separator or a date, not a command.
   * A source like `@` over file paths is the opposite — mid-sentence is exactly where it belongs.
   */
  lineStartOnly?: boolean;
  items: readonly CompletionItem[];
};

/** What the current input value resolves to, or undefined when no source applies. */
export type Completion = {
  source: CompletionSource;
  /** Index into the value where the completed token starts, so applyCompletion replaces only it. */
  tokenStart: number;
  /** The token as typed, trigger included. */
  token: string;
  matches: readonly CompletionItem[];
};

function tokenStartOf(value: string): number {
  const match = /\S*$/.exec(value);
  return match === null ? value.length : match.index;
}

function matchItems(items: readonly CompletionItem[], token: string): CompletionItem[] {
  const query = token.toLowerCase();
  const body = query.slice(1);
  const prefix: CompletionItem[] = [];
  const contains: CompletionItem[] = [];
  for (const item of items) {
    const value = item.value.toLowerCase();
    if (value.startsWith(query)) prefix.push(item);
    else if (body.length > 0 && value.includes(body)) contains.push(item);
  }
  return [...prefix, ...contains];
}

export function resolveCompletion(
  sources: readonly CompletionSource[],
  value: string,
): Completion | undefined {
  const tokenStart = tokenStartOf(value);
  const token = value.slice(tokenStart);
  if (token.length === 0) return undefined;
  for (const source of sources) {
    if (!token.startsWith(source.trigger)) continue;
    if (source.lineStartOnly === true && tokenStart !== 0) continue;
    const matches = matchItems(source.items, token);
    if (matches.length === 0) return undefined;
    return { source, tokenStart, token, matches };
  }
  return undefined;
}

/** Replaces the token being completed, and adds the trailing space that ends completion — so the
 *  popup closes on accept and the very next keystroke is an argument, not a further narrowing. */
export function applyCompletion(
  value: string,
  completion: Completion,
  item: CompletionItem,
): string {
  return `${value.slice(0, completion.tokenStart) + item.value} `;
}
