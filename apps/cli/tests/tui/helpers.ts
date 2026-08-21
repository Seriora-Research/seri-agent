// Shared test fixtures for the TUI test suite — App.test.tsx's own originals, factored out once
// inputRenderCost.test.tsx needed near-identical `session`/`route`/`flush`, so a third file
// (inputThrottle.test.tsx) reusing `flush` doesn't have to re-derive it a third time either.

import { EventEmitter } from "node:events";
import type { ModelMessage } from "ai";
import type { ResolvedRoute } from "../../src/provider/routing";
import type { SessionState } from "../../src/session/session";

export function session(
  overrides: Partial<SessionState<ModelMessage>> = {},
): SessionState<ModelMessage> {
  return {
    id: "s1",
    cwd: "/repo",
    systemPrompt: "",
    permissionMode: "approve-each",
    messages: [],
    ...overrides,
  };
}

// AppProps.route is required (D3's own invariant: a PreparedRun cannot exist without a resolved
// route) — every <App> mount needs one, not just a test that cares about its rendered content.
export function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    model: "claude-sonnet-5",
    provider: "anthropic",
    rerouted: false,
    viaGateway: false,
    ...overrides,
  };
}

// A render/dispatch is not reflected in lastFrame() synchronously — same finding
// inkInputSpike.test.tsx documents for useInput, just needing a macrotask tick here rather than a
// microtask (Ink's own frame write is throttled independently of React's own update scheduling).
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// FakeTty's own fixed column width — matches App.test.tsx's assumption that width doesn't vary
// across these tests. Named and exported rather than inlined into `FakeTty` below so a caller's
// own assertions (inputRenderCost.test.tsx's marginal-bytes threshold) can derive from the same
// value instead of hardcoding a number that would silently drift out of sync with it.
export const TEST_COLUMNS = 100;

// A fake TTY stdout: fixed `TEST_COLUMNS` columns, a configurable row count, and counters for
// every byte/call written to it — the thing a real terminal emulator has to parse and repaint.
// `raw` accumulates the actual written text (not just its length) so a test can assert on the
// bytes' own content, not only their count.
export class FakeTty extends EventEmitter {
  isTTY = true as const;
  columns = TEST_COLUMNS;
  rows: number;
  bytes = 0;
  writes = 0;
  raw = "";

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  write = (chunk: string): boolean => {
    this.bytes += chunk.length;
    this.writes += 1;
    this.raw += chunk;
    return true;
  };
}

// Copied from ink-testing-library's own Stdin (build/index.js) — the no-op raw-mode plumbing Ink
// expects from a real stdin, plus a synchronous write() that fires 'data' the way a real tty's
// keystrokes arrive.
export class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}
