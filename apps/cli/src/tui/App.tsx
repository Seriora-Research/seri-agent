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
import type { ModelPickerEntry, SetupProviderRow } from "./commands";
import { type Dispatch, initialTuiState, type SetupState, tuiReducer } from "./reducer";
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
  // /setup's own five resolutions (D5-D8, feature-plan.md) — mirroring onModelSelected's shape:
  // each does nothing but call into cli.ts's own handlers, which recompute the whole next
  // SetupState (rows included) and dispatch it, the same "presentation calls a prop, cli.ts owns
  // the decision" split every other interactive command in this file already has.
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
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
// Widest real value is "your key" (8 chars) — 9 leaves one column of breathing room, matching
// this file's other columns' own generosity over their own widest realistic value.
const ROUTE_WIDTH = 9;
// Cost was the table's last column before Route (D1/D2, feature-plan.md) became the new trailing
// one — formatCost's own output is genuinely variable-width ("—" vs "$150.00/$600.00"), which was
// fine when nothing followed it, but Route now does, so this pads it too, or Route would drift
// out of its own column depending on how expensive a given row's model is. 18 covers the widest
// real pair in the bundled manifest (measured: $150.00/$600.00, 15 characters) with a little room
// to spare, not the exact minimum.
const COST_WIDTH = 18;

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

// One row's worth of columns (name, provider, context, cost, route), space-joined — the picker's
// own selection marker ("> "/"  ") is prepended at the call site, not here, matching how the
// un-columned version already separated "which row is highlighted" from "what the row says".
// Factored out and exported specifically so column formatting is unit-testable without mounting
// Ink at all — this file had no pure formatting function of its own before the picker's columns
// needed one.
//
// D1/D2 (feature-plan.md): the trailing Route column names whether THIS row's own provider has a
// key ("your key"/"no key" — the same fact routing-priority resolution would act on) and, when
// this row is one of several routes to the same logical model (`alternatives > 0`, set by
// decideModelPickerOpen), how many OTHER routes exist — so a route with no key of its own but a
// reachable sibling still reads as reachable, not as a dead end.
export function formatModelRow(row: ModelPickerEntry): string {
  const { entry, keyConfigured, alternatives } = row;
  const suffix = alternatives > 0 ? ` +${alternatives} route${alternatives === 1 ? "" : "s"}` : "";
  return (
    [
      truncatePad(entry.displayName, NAME_WIDTH),
      truncatePad(entry.provider, PROVIDER_WIDTH),
      formatContextWindow(entry.contextWindow).padStart(CONTEXT_WIDTH),
      truncatePad(formatCost(entry.pricing), COST_WIDTH),
      truncatePad(keyConfigured ? "your key" : "no key", ROUTE_WIDTH),
    ].join(" ") + suffix
  );
}

// The picker's own column labels, same widths as formatModelRow's own columns — so the header sits
// flush above the rows it names regardless of terminal width.
const MODEL_PICKER_HEADER = [
  truncatePad("Name", NAME_WIDTH),
  truncatePad("Provider", PROVIDER_WIDTH),
  "Context".padStart(CONTEXT_WIDTH),
  truncatePad("Cost", COST_WIDTH),
  truncatePad("Route", ROUTE_WIDTH),
].join(" ");

// Multi-term AND-of-ORs, not a single unsplit substring check: the query is split on whitespace,
// and EVERY term must match at least one field (id, displayName, family, or — new in this commit —
// provider), independently. A single-term query behaves exactly as before (id/displayName/family,
// now also provider); a multi-term one (e.g. "sonnet-5 anthropic") is what lets a query narrow to
// one specific ROUTE of a multi-route model rather than only ever narrowing by name.
function matchesFilter(row: ModelPickerEntry, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const { entry } = row;
  const haystacks = [
    entry.id.toLowerCase(),
    entry.displayName.toLowerCase(),
    // `family` is a free-text field lifted verbatim from models.dev (ModelCatalogEntry's own
    // comment, packages/model-catalog/src/types.ts) — some upstream entries carry `null` there
    // rather than an empty string, so this cannot assume it is always safe to call
    // `.toLowerCase()` on directly.
    (entry.family ?? "").toLowerCase(),
    entry.provider.toLowerCase(),
  ];
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
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
  entries: ModelPickerEntry[];
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
    filterQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, filterQuery));

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
      const row = filtered[selectedIndex];
      if (row !== undefined) {
        onModelSelected?.({ model: row.entry.id, provider: row.entry.provider });
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
      nextQuery.length === 0 ? entries : entries.filter((row) => matchesFilter(row, nextQuery));
    const row = nextFiltered[0];
    if (row !== undefined) {
      onModelSelected?.({ model: row.entry.id, provider: row.entry.provider }, after || undefined);
    }
  });

  const visible = filtered.slice(scrollOffset, scrollOffset + MODEL_PICKER_WINDOW);
  const remaining = filtered.length - visible.length;

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text>{filterQuery.length > 0 ? filterQuery : " "}</Text>
      <Text color={theme.muted}>{`  ${MODEL_PICKER_HEADER}`}</Text>
      {visible.map((row, localIndex) => {
        const index = scrollOffset + localIndex;
        return (
          <Text
            key={`${row.entry.provider}/${row.entry.id}`}
            color={index === selectedIndex ? theme.accent : undefined}
          >
            {index === selectedIndex ? "> " : "  "}
            {formatModelRow(row)}
          </Text>
        );
      })}
      {remaining > 0 && <Text color={theme.muted}>+{remaining} more — keep typing to narrow</Text>}
    </Box>
  );
}

// D8: the disabled-remove reason, verbatim — reused by the list row (grayed prompt) and would be
// reused again by any future surface that needs to explain the same fact, rather than the string
// being typed out at each call site and risking drift.
function envShadowReason(keyName: string): string {
  return `set by $${keyName} in your environment — unset it in your shell`;
}

// One /setup list row's own text — masked value + source for a config/unset row, D8's own
// disabled-remove reason for an env row with nothing removable underneath it (which is more
// useful there than a masked value nobody can act on: the fix is in the shell, not in this
// panel).
//
// Bug fixed here (code-review, PR #73, round 3, item #5): an env row is not always the
// non-removable case — `row.removable` (providerKeyState's own `hasConfigEntry`) is true when a
// config.json entry sits underneath the env var that's shadowing it, and pressing 'r'/Delete on
// that row genuinely removes it. `envShadowReason`'s "unset it in your shell" text used to render
// unconditionally for EVERY env row, telling a user with a real, removable entry that removal was
// impossible when it was not — commands.ts's own comment on `decideSetupOpen` already claimed
// "the panel states why, for the env case," which was false for exactly this state until now.
export function formatSetupRow(row: SetupProviderRow): string {
  const name = truncatePad(row.provider, PROVIDER_WIDTH);
  if (row.source === "unset") return `${name} not set`;
  if (row.source === "env") {
    return row.removable
      ? `${name} ${row.masked} (env, config entry underneath — removable)`
      : `${name} ${envShadowReason(row.keyName)}`;
  }
  return `${name} ${row.masked} (config)`;
}

// /setup's own live state (tui/reducer.ts's pendingSetup) — mirrors ModelPicker's mutual-exclusion
// role, dispatching to one of three step-specific sub-components below rather than one component
// handling all three at once, since each step has genuinely different input handling and local
// state (the same reasoning ApprovalBox/ModelPicker are separate components rather than one
// component branching internally).
function SetupPanel({
  pendingSetup,
  onSetupSelect,
  onSetupKeyEntered,
  onSetupRemove,
  onSetupBack,
  onSetupClose,
}: {
  pendingSetup: SetupState;
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  if (pendingSetup.step === "enter-key") {
    return (
      <SetupEnterKey
        pendingSetup={pendingSetup}
        onSetupKeyEntered={onSetupKeyEntered}
        onSetupBack={onSetupBack}
        onSetupClose={onSetupClose}
      />
    );
  }
  if (pendingSetup.step === "confirm-remove") {
    return (
      <SetupConfirmRemove
        pendingSetup={pendingSetup}
        onSetupRemove={onSetupRemove}
        onSetupBack={onSetupBack}
      />
    );
  }
  return (
    <SetupList
      pendingSetup={pendingSetup}
      onSetupSelect={onSetupSelect}
      onSetupRemove={onSetupRemove}
      onSetupClose={onSetupClose}
    />
  );
}

function SetupList({
  pendingSetup,
  onSetupSelect,
  onSetupRemove,
  onSetupClose,
}: {
  pendingSetup: Extract<SetupState, { step: "list" }>;
  onSetupSelect?: (provider: ModelProvider) => void;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  const { rows } = pendingSetup;
  // Seeded from the reducer's own `selected` (set by whichever handler brought this step back into
  // view — cli.ts's own onSetupBack/onSetupKeyEntered), then moved locally — the same "reducer
  // supplies the starting point, the component owns live navigation" split ModelPicker's own
  // `selectedIndex` already has, for the identical reason (transient UI data with no reason to
  // round-trip through cli.ts on every arrow key).
  const [selected, setSelected] = useState(pendingSetup.selected);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "d")) {
      onSetupClose?.();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(rows.length - 1, current + 1));
      return;
    }
    const row = rows[selected];
    // Bug fixed here (code-review, PR #73, round 3): `key.return`/`key.delete` must be checked
    // BEFORE the `input.length === 0` guard below, not after — Ink's own key parser sets `input`
    // to `''` for every named key, Enter and Delete included (confirmed against
    // node_modules/ink/build/parse-keypress.js and use-input.js), so the empty-input guard used to
    // return before either of these two branches was ever reached. Every other useInput in this
    // file (ModelPicker, SetupEnterKey, SetupConfirmRemove) already has the ordering this way —
    // this was the one holdout, and it made Enter/Delete dead here despite the panel's own hint
    // text advertising them.
    if (key.return) {
      if (row !== undefined) onSetupSelect?.(row.provider);
      return;
    }
    if (key.delete) {
      if (row !== undefined && row.removable) onSetupRemove?.(row.provider);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (row === undefined) return;
    const typed = input.toLowerCase();
    if (typed === "a") {
      onSetupSelect?.(row.provider);
      return;
    }
    if (typed === "r" && row.removable) {
      onSetupRemove?.(row.provider);
    }
  });

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>/setup — provider API keys</Text>
      {rows.map((row, index) => (
        <Text key={row.provider} color={index === selected ? theme.accent : undefined}>
          {index === selected ? "> " : "  "}
          {formatSetupRow(row)}
        </Text>
      ))}
      <Text color={theme.muted}>
        ↑/↓ move · Enter/a add or replace · r remove · Esc/Ctrl-D close
      </Text>
    </Box>
  );
}

function SetupEnterKey({
  pendingSetup,
  onSetupKeyEntered,
  onSetupBack,
  onSetupClose,
}: {
  pendingSetup: Extract<SetupState, { step: "enter-key" }>;
  onSetupKeyEntered?: (provider: ModelProvider, value: string) => void;
  onSetupBack?: () => void;
  onSetupClose?: (leftoverInput?: string) => void;
}) {
  const { provider, keyName, error, busy } = pendingSetup;
  // The real value lives here, never in anything rendered — the frame below only ever shows
  // `"*".repeat(value.length)`. This is the one piece of state in this whole file a leaked render
  // would turn into a credential disclosure, which is why it exists nowhere else: not in
  // `pendingSetup` (reducer state, visible to anything that reads it), not passed back to cli.ts
  // until the moment it actually submits.
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input === "d") {
      onSetupClose?.();
      return;
    }
    if (key.escape) {
      onSetupBack?.();
      return;
    }
    if (key.return) {
      onSetupKeyEntered?.(provider, value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    // A bare terminator embedded in a combined pty chunk (MEDIUM-E's own class, InputBox/
    // ModelPicker above) is not handled beyond stripping it — a pasted key is never expected to
    // contain a newline, and silently accepting one into a credential is worse than the rare
    // dropped keystroke this simplification could cost.
    setValue((current) => current + input.replace(/[\r\n]/g, ""));
  });

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column">
      <Text color={theme.muted}>{`${keyName} for ${provider}`}</Text>
      <Text>{"*".repeat(value.length)}</Text>
      {error !== undefined && <Text color={theme.error}>{error}</Text>}
      {busy ? (
        <Text color={theme.muted}>Validating…</Text>
      ) : (
        <Text color={theme.muted}>Enter submit · Esc back · Ctrl-D close</Text>
      )}
    </Box>
  );
}

function SetupConfirmRemove({
  pendingSetup,
  onSetupRemove,
  onSetupBack,
}: {
  pendingSetup: Extract<SetupState, { step: "confirm-remove" }>;
  onSetupRemove?: (provider: ModelProvider) => void;
  onSetupBack?: () => void;
}) {
  const { provider, keyName } = pendingSetup;

  useInput((input, key) => {
    // ApprovalBox's own convention (above): Enter and anything unrecognised both cancel — only an
    // explicit "y" confirms.
    if (key.return) {
      onSetupBack?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 0) return;
    if (input.toLowerCase() === "y") {
      onSetupRemove?.(provider);
      return;
    }
    onSetupBack?.();
  });

  return (
    <Box borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning}>{`Remove ${keyName} (${provider})? [y]es / [N]o`}</Text>
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
  onSetupSelect,
  onSetupKeyEntered,
  onSetupRemove,
  onSetupBack,
  onSetupClose,
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
      only input that means anything until it clears. Extended to a third state for /model, and a
      fourth for /setup: each is the same kind of "only this input means anything right now"
      question, checked in this same order (approval, then /model, then /setup, then InputBox). */}
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
      ) : state.pendingSetup !== undefined ? (
        <SetupPanel
          pendingSetup={state.pendingSetup}
          onSetupSelect={onSetupSelect}
          onSetupKeyEntered={onSetupKeyEntered}
          onSetupRemove={onSetupRemove}
          onSetupBack={onSetupBack}
          onSetupClose={onSetupClose}
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
