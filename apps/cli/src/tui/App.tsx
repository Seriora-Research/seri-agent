// Root TUI component (Phase 4, feature-plan.md). Structurally correct and wired to Phase 2's
// reducer, not feature-complete: Phase 5 wires this to driveLoop and cli.ts's slash-command
// dispatch. <Static> is the direct replacement for output.ts's console.log/process.stdout.write
// calls — the same append-only, never-repainted transcript, rendered by Ink instead of printed
// directly. Everything below it is a live region: status/spinner, a pending-write placeholder, the
// mode indicator, and a basic input box, all re-rendered in place rather than scrolled.

import type { ModelCatalogEntry, ModelProvider } from "@seri/model-catalog";
import type { ModelMessage } from "ai";
import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import { approvalPromptText, truncateArgsDisplay } from "../cli/output";
import type { ApprovalAnswer } from "../loop/loop";
import type { SessionState } from "../session/session";
import { type Dispatch, initialTuiState, tuiReducer } from "./reducer";
import { theme } from "./theme";

export type AppProps = {
  session: SessionState<ModelMessage>;
  // The seam Phase 5 wires driveLoop's dispatch through: called once on mount with the reducer's
  // own dispatch function, the same shape `useReducer` returns. Optional because Phase 4's tests
  // exercise the reducer via `connectDispatch` directly, with no live loop behind it yet.
  connectDispatch?: (dispatch: Dispatch) => void;
  // Submitted line from the input box — Phase 5 wires this to the task/slash-command dispatch;
  // Phase 4 has nowhere real to send it yet.
  onSubmit?: (value: string) => void;
  // Called on a raw Ctrl-C keypress — the TUI's own route into signals.ts's cancel slot, mirroring
  // cli.ts's readline path (`rl.on("SIGINT", () => deliverSignal("SIGINT"))`). Needed because raw
  // mode (which both Ink and readline use) never lets the terminal driver turn 0x03 into a real
  // process SIGINT — the byte arrives as ordinary input instead, so whatever is reading input has
  // to recognise it explicitly. The caller (runTui's render() call) turns off Ink's own default
  // `exitOnCtrlC` behavior specifically so this is the only thing a Ctrl-C here does — leaving
  // Ink's default on would give Ink its own competing exit path that races the one driveLoop's
  // AbortController expects.
  onCancel?: () => void;
  // Called whenever the reducer's own `state.session` changes — a mode cycle, a rewind, or the
  // loop-event reducer's own messages-updated merge. This is now the single source of truth for
  // persistence on the TUI path (a real bug this fixes: driveLoop used to persist a session it had
  // captured once at the start of a turn, so the very next messages-updated write silently
  // reverted a mid-run /mode both on disk and, before this, in the reducer too). Not gated to skip
  // the initial mount call — prepareSession already saved that exact session to disk, so the first
  // call here is a harmless, idempotent rewrite of the same content, not a bug worth guarding.
  onSessionChange?: (session: SessionState<ModelMessage>) => void;
  // HIGH-1: the TUI's own graceful-quit trigger, called on /exit (onSubmit intercepts it before
  // the ordinary command dispatch — see runTui's own comment) and on Ctrl-D at the input box (the
  // normal Unix "end input" convention). runTui's implementation re-renders with done: true (the
  // hook below) and resolves its own outer promise once Ink has actually unmounted, which is what
  // lets run() reach printUsage/the exit-code logic at all on the TUI path — before this existed
  // there was no way to reach it.
  onQuit?: () => void;
  // True once runTui's own quit() has fired. Ink does not auto-exit on its own — Phase 1's own
  // hello-world smoke test hung until an explicit unmount()/exit() call was added — so this effect
  // is what ends the process, rather than relying on implicit auto-exit-on-unmount (also the
  // documented workaround for a macOS-only Bun/Ink cosmetic issue: cursor invisible after exit).
  done: boolean;
  // Findings 1+5 (thermo-nuclear structural review, round 6): answers the TUI-native approval
  // prompt (runTui's own tuiApprovalPrompt, cli.ts) — the ORIGINAL research-spec design ("a TUI
  // supplies a different function of the identical signature... with zero change to
  // loop.ts/gate.ts") that every earlier round of this branch left unbuilt, leaving the TUI path
  // calling makeApprovalPrompt's readline-based prompt instead: a SECOND stdin consumer and a
  // SECOND SIGINT route racing Ink's own raw-mode ownership and signals.ts's single cancel slot.
  onApprovalAnswer?: (answer: ApprovalAnswer) => void;
  // /model's own two resolutions, mirroring onApprovalAnswer's shape: called from ModelPicker's own
  // keypress handler, wired by runTui to dispatch model-picker-resolved (with or without a pick)
  // into the SAME reducer everything else here already shares. `onModelSelected` takes just the
  // pick (model + provider), not a whole session — TuiAction's own "model-picker-resolved" comment
  // explains why a whole captured session is the race this stopped carrying.
  // `leftoverInput`: text typed after a terminator embedded in the same combined pty chunk that
  // resolved this pick — see `pendingInputPrefill`'s own comment (reducer.ts). Absent on the
  // ordinary single-Enter path.
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
};

// approvalPromptText (cli/output.ts), not a hand-copied template: round 7 code review found this
// line written out twice (here and in makeApprovalPrompt's own rl.question call, cli.ts) — same
// escaping, same PERSISTABLE_TOOLS-gated "always" option, same [N]o-is-the-default framing, now
// from one shared function, so switching between the non-interactive and TUI paths is not also a
// UX change and the two can't drift apart the way toolResultLine/toolAllowedLine already prevent
// elsewhere. Captures a single keypress instead of readline's line-buffered question: y/a/n
// answer directly, Enter defaults to "no" (the bracketed capital in "[N]o"), and — matching
// makeApprovalPrompt's own "anything unrecognised is 'no'" rule, applied per-keystroke here
// instead of per-line — so does everything else, except Ctrl-D (quits, see onQuit below) and a
// bare Ctrl/Meta chord otherwise (Ctrl-C included, which App's own useInput below already routes
// to onCancel/signals.ts; answering "no" here too would just be a redundant second resolution of
// the same promise, not incorrect, but not this component's concern either).
function ApprovalBox({
  pendingApproval,
  onAnswer,
  onQuit,
}: {
  pendingApproval: { toolName: string; args: unknown; offersAlways: boolean };
  onAnswer?: (answer: ApprovalAnswer) => void;
  onQuit?: () => void;
}) {
  const { toolName, args, offersAlways } = pendingApproval;

  useInput((input, key) => {
    // Round 7 code review: Ctrl-D used to do nothing while this component was mounted instead of
    // InputBox — quit() itself (cli.ts) denies the pending approval as part of the same graceful
    // sequence before proceeding, so this is the same onQuit InputBox's own Ctrl-D calls, not a
    // separate "deny just this one prompt" path.
    if (key.ctrl && input === "d") {
      onQuit?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.return) {
      onAnswer?.("no");
      return;
    }
    // Round 8 code review, finding 2: an arrow key, Backspace, Tab, Escape, or any other
    // non-printable key Ink recognises by name (not by text) reports `input === ""` from its own
    // parser (parse-keypress.js/use-input.js) — the same empty shape key.ctrl/key.meta above are
    // already excluded for. Without this, one of those fell straight into the "anything
    // unrecognised is 'no'" catch-all below, meant for actual mistyped TEXT, and silently denied
    // the approval on a stray navigation keypress — makeApprovalPrompt's own readline-based prompt
    // has no equivalent failure mode, since those keys only edit or no-op its line buffer.
    if (input.length === 0) return;
    const typed = input.toLowerCase();
    if (typed === "y") {
      onAnswer?.("once");
      return;
    }
    if (offersAlways && typed === "a") {
      onAnswer?.("always");
      return;
    }
    onAnswer?.("no");
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{approvalPromptText(toolName, args, offersAlways)}</Text>
    </Box>
  );
}

// The most a picker window ever shows at once, regardless of how many entries match the current
// filter — the catalog easily runs into the hundreds (models.dev's own OpenRouter listing), and
// rendering all of them would scroll the picker itself out of view, the same reasoning
// truncateArgsDisplay already applies to a single long line. `selectedIndex` can move past this
// many rows (arrow-key navigation over the full filtered list, not just what's on screen) — see
// `scrollOffset`, below, for how the visible window slides to keep it in view.
const MODEL_PICKER_WINDOW = 10;

// Column widths for formatModelRow/MODEL_PICKER_HEADER below — plain padded strings, not a table
// component: this repo hand-rolls its TUI deliberately (App.tsx's own file-level comment) and Ink
// has none built in.
const NAME_WIDTH = 22;
const PROVIDER_WIDTH = 10;
const CONTEXT_WIDTH = 7;

// Truncates with a trailing ellipsis (never mid-multi-byte-safe beyond what .slice already is —
// every field this feeds is plain ASCII: a model id/displayName/provider name) or pads with
// trailing spaces, so every row's later columns start at the same screen column regardless of an
// earlier one's actual length.
function truncatePad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// Binary units (1024, not 1000): matches how a context window is actually described everywhere
// else this repo prints one (contextWindowSize's own comments, loop.ts) — 131,072 is "128K" this
// way, matching the task's own worked example, not "131K" a decimal K would give.
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${(tokens / (1024 * 1024)).toFixed(1)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return `${tokens}`;
}

// "—" (not "?"/"unknown"/blank) for the same reason printCost (cli/output.ts) writes out "unknown"
// rather than a bare "$": pricing.ts's own ModelCatalogEntry.pricing comment says `undefined` means
// models.dev never published a rate for this entry, not that it is free — an em dash reads as "no
// data" without implying either.
export function formatCost(pricing: ModelCatalogEntry["pricing"]): string {
  if (pricing === undefined) return "—";
  return `$${pricing.inputPerMTok.toFixed(2)}/$${pricing.outputPerMTok.toFixed(2)}`;
}

// One row's worth of columns (name, provider, context, cost), space-joined — the picker's own
// selection marker ("> "/"  ") is prepended at the call site, not here, matching how the un-columned
// version already separated "which row is highlighted" from "what the row says". Factored out and
// exported specifically so column formatting is unit-testable without mounting Ink at all — this
// file had no pure formatting function of its own before the picker's columns needed one.
export function formatModelRow(entry: ModelCatalogEntry): string {
  return [
    truncatePad(entry.displayName, NAME_WIDTH),
    truncatePad(entry.provider, PROVIDER_WIDTH),
    formatContextWindow(entry.contextWindow).padStart(CONTEXT_WIDTH),
    formatCost(entry.pricing),
  ].join(" ");
}

// The picker's own column labels, same widths as formatModelRow's own columns — so the header sits
// flush above the rows it names regardless of terminal width.
const MODEL_PICKER_HEADER = [
  truncatePad("Name", NAME_WIDTH),
  truncatePad("Provider", PROVIDER_WIDTH),
  "Context".padStart(CONTEXT_WIDTH),
  "Cost",
].join(" ");

function matchesFilter(entry: ModelCatalogEntry, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    entry.id.toLowerCase().includes(needle) ||
    entry.displayName.toLowerCase().includes(needle) ||
    // `family` is a free-text field lifted verbatim from models.dev (ModelCatalogEntry's own
    // comment, packages/model-catalog/src/types.ts) — some upstream entries carry `null` there
    // rather than an empty string, so this cannot assume it is always safe to call
    // `.toLowerCase()` on directly.
    (entry.family ?? "").toLowerCase().includes(needle)
  );
}

// /model's own live state (tui/reducer.ts's pendingModelPicker) — mirrors ApprovalBox's shape
// exactly: its own useInput, a round-bordered box, mutually exclusive with InputBox. `filterQuery`
// and `selectedIndex` are local component state, not reducer state, for the same reason InputBox's
// own `value` is: this is transient UI data with no reason to survive a resolve/cancel or be
// visible to anything outside this component.
function ModelPicker({
  entries,
  onModelSelected,
  onModelPickerCancel,
}: {
  entries: ModelCatalogEntry[];
  onModelSelected?: (
    pick: { model: string; provider: ModelProvider },
    leftoverInput?: string,
  ) => void;
  onModelPickerCancel?: () => void;
}) {
  const [filterQuery, setFilterQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // C1 fix: the window rendered used to always be `filtered.slice(0, MODEL_PICKER_WINDOW)` —
  // the first N entries, regardless of `selectedIndex` — so Down past the visible window moved
  // the highlight somewhere nothing on screen showed, and with 279 catalog entries most of the
  // list was unreachable. `scrollOffset` is the top of the currently-rendered window; it only
  // moves when `selectedIndex` would otherwise land outside `[scrollOffset, scrollOffset +
  // MODEL_PICKER_WINDOW)` (moveSelection, below) — not recomputed fresh from `selectedIndex` on
  // every render, which would re-center the window on every keypress instead of sliding it only
  // when actually needed.
  const [scrollOffset, setScrollOffset] = useState(0);

  const filtered =
    filterQuery.length === 0
      ? entries
      : entries.filter((entry) => matchesFilter(entry, filterQuery));

  // Moves the selection to `next` (already clamped to `[0, filtered.length - 1]` by the caller)
  // and slides `scrollOffset` only far enough to keep it inside the visible window — the classic
  // "clamp, don't re-center" rule a sliding window needs so scrolling up from the bottom of a long
  // list doesn't snap back to the top the instant the highlight re-enters the window it was
  // already inside.
  function moveSelection(next: number): void {
    setSelectedIndex(next);
    setScrollOffset((offset) => {
      if (next < offset) return next;
      if (next >= offset + MODEL_PICKER_WINDOW) return next - MODEL_PICKER_WINDOW + 1;
      return offset;
    });
  }

  useInput((input, key) => {
    // Escape OR Ctrl-D — deliberately NOT ApprovalBox's Ctrl-D (which triggers app quit): this is
    // "never mind, back to typing", not a graceful-quit sequence.
    if (key.escape || (key.ctrl && input === "d")) {
      onModelPickerCancel?.();
      return;
    }
    if (key.upArrow) {
      moveSelection(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      moveSelection(Math.min(filtered.length - 1, selectedIndex + 1));
      return;
    }
    if (key.return) {
      const entry = filtered[selectedIndex];
      if (entry !== undefined) {
        onModelSelected?.({ model: entry.id, provider: entry.provider });
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      setFilterQuery((query) => query.slice(0, -1));
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    if (input.length === 0) return;
    // MEDIUM-E's own finding (InputBox, above), applying here too: a chunk delivered faster than
    // one keypress per `useInput` call — typed filter text immediately followed by Enter, measured
    // on a real pty to arrive as ONE combined chunk rather than two separate calls — can embed a
    // `\r`/`\n` that `key.return` above never sees, since that only fires for a chunk that IS a
    // bare terminator on its own. Everything up to the first terminator is filter text; the
    // terminator itself selects the top match against the FULLY updated query, mirroring
    // `key.return`'s own action (against `selectedIndex 0`, the same reset every other
    // filter-changing keystroke already applies) rather than silently dropping the keystroke.
    const terminatorIndex = input.search(/[\r\n]/);
    const typed = terminatorIndex === -1 ? input : input.slice(0, terminatorIndex);
    const nextQuery = filterQuery + typed;
    if (terminatorIndex === -1) {
      setFilterQuery(nextQuery);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    // Code-review finding: this used to stop at `typed` and silently discard everything after the
    // terminator — real keystrokes vanished with no trace once the picker closed. `terminatorLength`
    // mirrors InputBox's own MEDIUM-4 fix (a `\r\n` pair, the common Windows-clipboard shape, is ONE
    // terminator, not two) and `after` is handed to `onModelSelected` so it can prefill the very next
    // InputBox mount — the closest equivalent here to InputBox's own "awaiting its own Enter" carry.
    const terminatorLength = input.startsWith("\r\n", terminatorIndex) ? 2 : 1;
    const after = input.slice(terminatorIndex + terminatorLength);
    const nextFiltered =
      nextQuery.length === 0 ? entries : entries.filter((entry) => matchesFilter(entry, nextQuery));
    const entry = nextFiltered[0];
    if (entry !== undefined) {
      onModelSelected?.({ model: entry.id, provider: entry.provider }, after || undefined);
    }
  });

  const visible = filtered.slice(scrollOffset, scrollOffset + MODEL_PICKER_WINDOW);
  const remaining = filtered.length - visible.length;

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text>{filterQuery.length > 0 ? filterQuery : " "}</Text>
      <Text color={theme.muted}>{`  ${MODEL_PICKER_HEADER}`}</Text>
      {visible.map((entry, localIndex) => {
        const index = scrollOffset + localIndex;
        return (
          <Text
            key={`${entry.provider}/${entry.id}`}
            color={index === selectedIndex ? theme.accent : undefined}
          >
            {index === selectedIndex ? "> " : "  "}
            {formatModelRow(entry)}
          </Text>
        );
      })}
      {remaining > 0 && <Text color={theme.muted}>+{remaining} more — keep typing to narrow</Text>}
    </Box>
  );
}

function InputBox({
  onSubmit,
  onQuit,
  prefill,
  onPrefillConsumed,
}: {
  onSubmit?: (value: string) => void;
  onQuit?: () => void;
  // Leftover text from a combined-chunk terminator in a just-closed ModelPicker (see
  // reducer.ts's `pendingInputPrefill`) — read once, as this mount's own starting value, never
  // re-applied on a later mount because `onPrefillConsumed` clears it in the same tick.
  prefill?: string;
  onPrefillConsumed?: () => void;
}) {
  const [value, setValue] = useState(prefill ?? "");
  useEffect(() => {
    if (prefill !== undefined) onPrefillConsumed?.();
    // `prefill` in deps is what Biome's react-hooks rule wants, not a real re-subscription: this
    // effect only ever needs to run once, and it only ever DOES run once, because InputBox is a
    // fresh instance every time it (re)mounts (see the render ternary below) — "on mount" already
    // means "once per pick", so a changed `prefill` on an already-mounted instance never happens.
  }, [prefill, onPrefillConsumed]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit?.(value);
      setValue("");
      return;
    }
    // Ctrl-D, the normal Unix "end input" convention — HIGH-1's other trigger for the same quit
    // path /exit uses (App.tsx's own onQuit prop, wired by runTui).
    if (key.ctrl && input === "d") {
      onQuit?.();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      // MEDIUM-E: `key.return` above only fires for a chunk that IS a bare terminator on its
      // own — a paste (delivered as one multi-character `input` chunk, not one useInput call per
      // character; a pasted stack trace is the real case) can embed a `\r`/`\n` that key.return
      // never sees, so without this it fell straight into the plain append below and the
      // terminator ended up embedded literally in the input, never submitting. Splits on the
      // FIRST terminator only: everything before it submits now, same as pressing Enter right
      // there; everything after becomes the new input value, awaiting its own Enter rather than
      // being silently swallowed or further auto-split.
      const terminatorIndex = input.search(/[\r\n]/);
      if (terminatorIndex === -1) {
        setValue((current) => current + input);
        return;
      }
      const before = input.slice(0, terminatorIndex);
      // MEDIUM-4: a `\r\n` pair (a Windows-clipboard paste is the common source) is ONE
      // terminator, not two — stripping only the `\r` left a stray leading `\n` in `after`,
      // requiring an extra, confusing Enter to clear what looked like a blank line, and
      // embedding a raw `\r\n` into whatever slash-command parsing ran on it next.
      const terminatorLength = input.startsWith("\r\n", terminatorIndex) ? 2 : 1;
      const after = input.slice(terminatorIndex + terminatorLength);
      onSubmit?.(value + before);
      setValue(after);
    }
  });

  return (
    <Box borderStyle="round" borderColor={theme.muted}>
      <Text>{value.length > 0 ? value : " "}</Text>
    </Box>
  );
}

export function App({
  session,
  connectDispatch,
  onSubmit,
  onCancel,
  onSessionChange,
  onQuit,
  done,
  onApprovalAnswer,
  onModelSelected,
  onModelPickerCancel,
}: AppProps) {
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState(session));
  const { exit } = useApp();

  useEffect(() => {
    connectDispatch?.(dispatch);
  }, [connectDispatch]);

  useEffect(() => {
    if (done) exit();
  }, [done, exit]);

  useEffect(() => {
    onSessionChange?.(state.session);
  }, [state.session, onSessionChange]);

  // A second, independent useInput from InputBox's own — Ink delivers the same keypress to every
  // registered handler, so this fires regardless of what InputBox does with the same press (today,
  // nothing: InputBox's own handler skips any key.ctrl input).
  useInput((input, key) => {
    if (key.ctrl && input === "c") onCancel?.();
  });

  return (
    <Box flexDirection="column">
      <Static items={state.transcript}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      {state.streaming.length > 0 && <Text>{state.streaming}</Text>}
      {state.pendingTool !== undefined && (
        <Box borderStyle="round" borderColor={theme.warning}>
          {/* truncateArgsDisplay (cli/output.ts), not a raw JSON.stringify: pendingTool is set
          ONLY for write_file/edit (reducer.ts), the two tools whose args carry a whole file body —
          exactly the case the helper exists for, uncapped here otherwise. */}
          <Text color={theme.warning}>
            {`${state.pendingTool.name}(${truncateArgsDisplay(state.pendingTool.args)})`}
          </Text>
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.accent}>{state.modeIndicator}</Text>
        {state.status.length > 0 && <Text color={theme.muted}>{state.status}</Text>}
      </Box>
      {state.commandError !== undefined && <Text color={theme.error}>{state.commandError}</Text>}
      {/* Findings 1+5: mutually exclusive with InputBox — a pending approval question is the only
      thing this run is waiting on, and answering it (not typing a task or slash command) is the
      only input that means anything until it clears. Extended to a third state for /model: a
      pending model pick is the same kind of "only this input means anything right now" question. */}
      {state.pendingApproval !== undefined ? (
        <ApprovalBox
          pendingApproval={state.pendingApproval}
          onAnswer={onApprovalAnswer}
          onQuit={onQuit}
        />
      ) : state.pendingModelPicker !== undefined ? (
        <ModelPicker
          entries={state.pendingModelPicker.entries}
          onModelSelected={onModelSelected}
          onModelPickerCancel={onModelPickerCancel}
        />
      ) : (
        <InputBox
          onSubmit={onSubmit}
          onQuit={onQuit}
          prefill={state.pendingInputPrefill}
          onPrefillConsumed={() => dispatch({ type: "input-prefill-consumed" })}
        />
      )}
    </Box>
  );
}
