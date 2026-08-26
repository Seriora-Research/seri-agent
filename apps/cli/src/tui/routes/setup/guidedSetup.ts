// Extracted from cli.ts — the liveState/dispatch mirror, every guided-setup-only handler closure,
// and the two-then-three module-level UI string constants together made cli.ts's own copy of this
// function large enough to warrant its own file. Self-contained: the only thing it needs is
// `createSetupHandlers`, imported directly from its own module (../../state/handlers) — shared
// byte-identical with `runTui` (cli.ts), with no dependency back on cli.ts itself.
import { randomUUID } from "node:crypto";
import type { ModelCatalog, ModelProvider } from "@seri/model-catalog";
import { createElement } from "react";
import { messageOf } from "../../../errors";
import { catalogWithFallback } from "../../../provider/catalog";
import { persistDefaultModel } from "../../../provider/defaults";
import { configuredProviders } from "../../../provider/keys";
import { App } from "../../app";
import { getTuiRenderer } from "../../runtime/renderer";
import {
  decideAuthOffer,
  decideGuidedModelPickerOpen,
  decideSetupOpen,
} from "../../state/commands";
import { createSetupHandlers } from "../../state/handlers";
import { type Dispatch, initialTuiState, type TuiState, tuiReducer } from "../../state/reducer";

// `runGuidedSetup`'s own mandatory-picker copy — named constants rather than inlined literals, so
// tuiPty.test.ts's own pty tests can assert a substring of the exact wording without duplicating
// it by hand.
const GUIDED_MODEL_PROMPT = "Pick a default model to continue.";
const GUIDED_MODEL_REQUIRED = "Pick a model to continue — Ctrl-C to quit without saving one.";
// The one visible line between an Escape press and the picker actually appearing, whenever
// `catalogPromise` is still resolving at that point.
const GUIDED_MODEL_LOADING = "Loading available models…";
// Escape/Ctrl-D pressed again while still "closing" would otherwise be a bare, silent no-op —
// indistinguishable from a dead key, especially from the "enter-key" step (SetupEnterKey's own
// Ctrl-D goes straight to onSetupClose, not through onSetupBack).
const GUIDED_MODEL_STILL_LOADING = "Still loading available models — one moment.";

// Rendered only when the pre-`prepareSession` gate in `run()` finds a real TTY and zero API keys
// configured anywhere (env or config.json) — the "genuinely blank first run" case that would
// otherwise hard-exit before the TUI ever mounts (BYOK-KEY-STORAGE-AND-SETUP.md, Open 2). Renders
// `App` seeded directly into the `/setup` panel via a `connectDispatch`-fired `setup-requested`
// action, reusing `createSetupHandlers` so this shares byte-identical /setup logic with `runTui`.
// The session passed to `App` is a throwaway: `id`/`cwd` only need to satisfy `AppProps.session`'s
// type (`SessionState<ModelMessage>`, not the stricter `RunSession` — no `model`/`provider`
// required), and are never saved to disk or read again once this function resolves — the real
// session `prepareSession` builds afterward (run()'s own call site) is what the run actually uses.
//
// A two-step flow, not one: closing /setup with at least one key configured does not resolve
// `closed` on its own — it opens the
// mandatory model picker (`onGuidedModelSelected`/`onGuidedModelPickerCancel`, below), which is
// what a completed guided setup actually needs to leave `config.json` in a runnable state
// (SERI_MODEL/SERI_PROVIDER persisted, not just a key). Declining (no key ever added) still closes
// immediately, byte-for-byte the old single-step behavior. `catalogPromise` is started by `run()`'s
// own call site but deliberately NOT awaited there — see that call site's own comment for why, and
// `onSetupClose`'s own header comment for why it stays synchronous
// and chains `.then`/`.catch` on that promise rather than awaiting it inline.
export async function runGuidedSetup(
  configDir: string,
  catalogPromise: Promise<ModelCatalog>,
): Promise<void> {
  const { root } = await getTuiRenderer();

  // Same synchronous-mirror pattern as runTui's own `liveState`/`dispatch` — kept here, not
  // shared, because runTui's copy is read from ~20 call sites across a much larger closure, where
  // genuinely unifying the two would mean rewriting every one of those reads (deferred as too much
  // blast radius). The invariant is the same: `dispatch` updates
  // `liveState` BEFORE handing the action to React, so anything reading `liveState` right after a
  // `dispatch` call (this function's own `onSetupClose`, `createSetupHandlers`'s `getPendingSetup`)
  // sees the post-action state synchronously rather than racing React's own effect-scheduled commit.
  let liveState: TuiState = initialTuiState({
    id: randomUUID(),
    cwd: process.cwd(),
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
  });
  let reactDispatch: Dispatch | undefined;
  const dispatch: Dispatch = (action) => {
    liveState = tuiReducer(liveState, action);
    reactDispatch?.(action);
  };

  let resolveClosed!: () => void;

  // An arrow, not a bare `resolveClosed` reference: this call happens before `resolveClosed` is
  // assigned (below), so passing the binding directly would capture `undefined` — the arrow defers
  // the read of `resolveClosed` until `onPanelClosed` is actually invoked, by which point it is set.
  const { onSetupSelect, onSetupKeyEntered, onSetupRemove, onSetupBack } = createSetupHandlers({
    dispatch,
    getPendingSetup: () => liveState.pendingSetup,
    configDir,
    onPanelClosed: () => resolveClosed(),
  });

  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  // Re-prompt, never exit. Because this NEVER dispatches
  // `model-picker-resolved`, `state.pendingModelPicker` stays set and `ModelPicker` stays mounted
  // with its own local filter/selection intact — the user gets a visible reason instead of the
  // panel silently doing nothing. `command-error`, not `transcript-append`: it is a single-slot
  // field rendered above the picker, so holding Escape replaces one line instead of flooding the
  // transcript. Ctrl-C is still the way out and needs no code here — `runtime/renderer.ts`'s own
  // registration handles it, this phase included.
  function onGuidedModelPickerCancel(): void {
    dispatch({ type: "command-error", message: GUIDED_MODEL_REQUIRED });
  }

  // Persists synchronously, on selection — not the `messages-updated` path
  // (`runTurn`'s own `onEvent`), which never fires in this phase (no turn ever runs here). The
  // write is synchronous (`persistDefaultModel` -> one `setConfigValues` call), so by the time
  // `await closed` (below) returns, config.json already carries the pair and `prepareSession`'s
  // own `resolveDefaultModel` reads it instead of falling back to groq's default. The try/catch
  // mirrors `onSetupKeyEntered`'s own write-failure posture: degrade to a visible message and
  // leave the user in control, never resolve into a state the next step cannot survive.
  function onGuidedModelSelected(pick: {
    model: string;
    provider: ModelProvider;
    keyConfigured: boolean;
  }): void {
    try {
      persistDefaultModel(pick, configDir);
    } catch (err) {
      dispatch({
        type: "command-error",
        message: messageOf(err),
      });
      return; // picker stays up; Ctrl-C is the way out
    }
    dispatch({ type: "model-picker-resolved", pick });
    resolveClosed();
  }

  // `AppProps.onSetupClose` is typed `(leftoverInput?) => void` — TypeScript silently drops a
  // returned promise there, so an `async function onSetupClose` awaiting `catalogPromise` inline
  // would be, in practice, fire-and-forget from every caller's point of view: a second Escape press
  // while it was still pending would re-enter the function and both resumes would run the tail
  // (duplicate dispatches); and the wait itself would be silent, with no feedback between the
  // keypress and the picker appearing. `onSetupClose` stays synchronous instead — the wait is
  // chained with `.then`/`.catch` instead of `await`ed inline, which avoids both of those — and
  // `closing` guards re-entry. `.then`'s second argument only catches `catalogPromise` itself
  // rejecting, though, not a throw from inside the first argument's own body — that half needs its
  // own try/catch (below).
  let closing = false;

  // The shared degrade for every path that must resolve this phase WITHOUT ever opening the
  // mandatory picker — reused rather than repeated at each of the four call sites below.
  function closeWithoutPicker(): void {
    dispatch({ type: "setup-resolved" });
    resolveClosed();
  }

  function onSetupClose(): void {
    // Re-entrancy guard: a second Escape/Ctrl-D press while `catalogPromise` is still resolving
    // must not re-run the tail below racing the first on the same promise — but it still needs
    // visible feedback, not a silent no-op that looks like a dead key from the "enter-key" step,
    // where Ctrl-D reaches onSetupClose directly.
    if (closing) {
      dispatch({ type: "command-error", message: GUIDED_MODEL_STILL_LOADING });
      return;
    }
    let configured: ReadonlySet<ModelProvider>;
    try {
      configured = configuredProviders(configDir);
    } catch {
      // Same degrade as connectDispatch's own catch, below: a corrupted config.json resolves out
      // and falls through to prepareSession's own configuredProviders read, which prints the one
      // canonical message, rather than a second, differently-worded error here.
      closeWithoutPicker();
      return;
    }
    if (configured.size === 0) {
      // The decline path — today's behavior, byte-for-byte: no key was ever added (or one was
      // added then removed), so there is nothing to pick a model FOR. Falls through to
      // prepareSession's own missing-key message, same as always.
      closeWithoutPicker();
      return;
    }
    closing = true;
    // Visible feedback for the wait that follows: the fetch
    // started at run()'s own call site can still be in flight here (up to FETCH_TIMEOUT_MS), and
    // without a line here, Escape looked completely dead for however long that takes.
    dispatch({ type: "transcript-append", line: GUIDED_MODEL_LOADING });
    // Chained, not awaited inline (see this function's own header comment for why): the fetch
    // started at run()'s own call site can still be in flight here, so by the time a real user has
    // picked a provider and typed a key it has almost always already resolved — this only actually
    // waits in the rare case it's still pending, and only after the visible line just above.
    catalogPromise.then(
      (catalog) => {
        closing = false;
        // If the user has since navigated away from the list step — the only step Escape closes
        // FROM — while this was in flight (e.g. pressed 'a' to add another key), the picker must
        // not silently overwrite whatever they're doing now: App.tsx's own render ternary checks
        // `pendingModelPicker` before `pendingSetup`, so an unconditional dispatch here would
        // discard a key they're mid-typing. Bail out and let their NEXT Escape re-trigger this —
        // `catalogPromise` is already resolved by then, so `.then` fires on the next tick.
        if (liveState.pendingSetup?.step !== "list") return;
        try {
          // Re-read, not the `configured` snapshot captured above: this wait can take up to
          // FETCH_TIMEOUT_MS, and a remove-then-re-add
          // round-trip (`r`→`y`, then `a`) returns to the "list" step — the only thing the guard
          // above checks — without ever tripping it. Reusing the stale snapshot here could offer
          // (and persist) a default model for a provider whose key was removed in the meantime,
          // reproducing the exact missing-key bug this feature exists to prevent.
          const freshConfigured = configuredProviders(configDir);
          if (freshConfigured.size === 0) {
            // Every key was removed during the wait — the same decline path as this function's
            // own initial `configured.size === 0` check, above.
            closeWithoutPicker();
            return;
          }
          // `catalog` here is the LIVE models.dev payload: a provider whose upstream `models` entry
          // is missing/malformed comes back with zero rows for it, even though the key the user just
          // saved is for that exact provider. `catalogWithFallback` backfills only that provider's
          // rows from the bundled manifest, scoped to what `freshConfigured` actually is.
          const entries = decideGuidedModelPickerOpen(
            catalogWithFallback(catalog, freshConfigured),
            freshConfigured,
          );
          if (entries.length === 0) {
            // Unreachable in practice — the bundled manifest carries real rows for every provider,
            // and decideGuidedModelPickerOpen only ever excludes rows, never invents one for a
            // provider it has none for — but a blank picker has no way to proceed except a fatal
            // Ctrl-C, so this degrades to the decline path instead of rendering zero rows.
            closeWithoutPicker();
            return;
          }
          // At least one key is configured and has a runnable model: a default model pick is now
          // mandatory before this phase can resolve. `model-picker-requested`
          // dispatched BEFORE `setup-resolved` is deliberate — App.tsx's own render ternary checks
          // `pendingModelPicker` before `pendingSetup`, so no intermediate frame can render a bare
          // `InputBox` even without React batching.
          dispatch({ type: "transcript-append", line: GUIDED_MODEL_PROMPT });
          dispatch({ type: "model-picker-requested", entries });
          dispatch({ type: "setup-resolved" });
        } catch {
          // This callback's own body can throw (the fresh
          // `configuredProviders` read above, a future change to `decideGuidedModelPickerOpen` or
          // `dispatch`) — `.then`'s second argument only catches `catalogPromise` REJECTING, not a
          // throw from inside this first argument, so an uncaught one here would become an
          // unhandled rejection that can kill the process before this window's own renderer is
          // ever destroyed. Degrade the same clean way every other failure path in this function
          // does.
          closeWithoutPicker();
        }
      },
      () => {
        // `getModelCatalog` never rejects (catalog.ts's own contract: a network failure or timeout
        // resolves to the fallback manifest instead) and decideGuidedModelPickerOpen is a pure
        // filter over already-loaded data with no throw path — this handler exists only so a
        // violation of either contract degrades the same clean way the branches above do, instead
        // of becoming an unhandled rejection that kills the process before this window's own
        // renderer is ever destroyed, leaving the terminal in raw mode.
        closing = false;
        closeWithoutPicker();
      },
    );
  }

  root.render(
    createElement(App, {
      session: liveState.session,
      // No PreparedRun exists yet at this point in startup (that's the whole reason this phase
      // exists — run()'s pre-prepareSession gate found zero configured keys), so there is no
      // ResolvedRoute to pass. AppProps.route's own comment covers why this is `| undefined`
      // rather than a fabricated value.
      route: undefined,
      catalog: undefined, // same reason as route above: no PreparedRun exists yet at this point
      // Unlike route/catalog, an empty record here isn't a stand-in for "unavailable" — `state
      // .route` being undefined already drops the whole effort-tier suffix (formatModeDetail's own
      // route gate, app.tsx), so what config.json holds is unobservable at this mount regardless.
      config: {},
      onQuit: onSetupClose, // dead in this phase (InputBox/ApprovalBox never show) but wired for safety
      onModelSelected: onGuidedModelSelected,
      onModelPickerCancel: onGuidedModelPickerCancel,
      onSetupSelect,
      onSetupKeyEntered,
      onSetupRemove,
      onSetupBack,
      onSetupClose,
      connectDispatch: (reducerDispatch: Dispatch) => {
        reactDispatch = reducerDispatch;
        // Guarded like every other decideSetupOpen call site in this file: config.json can be
        // corrupted between run()'s own pre-check and
        // this effect firing (a racing second `seri` process, a hand edit). Unlike a command-error
        // dispatch (there is no InputBox/transcript visible here to show one), resolving `closed`
        // and leaving the key unadded makes `run()` fall through unconditionally (its own
        // "No re-check after runGuidedSetup returns" comment, cli.ts) into `prepareSession`'s OWN
        // `configuredProviders(configDir)` read (that function's own try/catch) hitting the
        // identical throw and print/exit — the same clean-exit path a corrupted config already gets
        // everywhere else, reached here without a second, differently-worded error message.
        try {
          dispatch({ type: "setup-requested", rows: decideSetupOpen(configDir) });
          // The passive AuthBanner only — this phase's own `pendingAuth` is unreachable
          // regardless (no createAuthHandlers here, by design; see this function's own header
          // comment), but the banner is independent of that (TuiState.authOffer's own comment).
          dispatch({ type: "auth-offer", show: decideAuthOffer(configDir) });
        } catch {
          resolveClosed();
        }
      },
    }),
  );

  // A fatal Ctrl-C/SIGTERM while this panel is up has no turn in flight to cancel, so
  // `runtime/renderer.ts`'s own `deliverSignal`
  // call takes the fatal branch and kills the process by signal without ever reaching `await closed`
  // below. `getTuiRenderer`'s own registration (runtime/renderer.ts) is what puts the terminal's
  // raw-mode/stdin state back before that happens — no separate registration needed here.
  await closed;
}
