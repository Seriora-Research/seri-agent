import type { LoopEvent, runLoop } from "../../src/loop/loop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

// The ~5-line async generator every fake in cli.test.ts and argv.test.ts rebuilt by hand: capture
// what cli.ts passed runLoop, yield the given events (default: a single "no-tool-call" done), and
// return opts.messages — which is NOT what the real generator does and which nothing reads: every
// `return` in loop.ts is bare, and cli.ts drives it with `for await`, which discards a generator's
// return value either way. Usage and every other result travel as events, not as a return value.
// `capture()` reads back what was captured —
// undefined if runLoop was never called — so a test that only needs "was it called" and one that
// needs the actual opts share the same fake instead of each hand-rolling their own.
//
// In its own file because the two test files held byte-identical copies, comment included, and the
// correction to that comment then had to be made twice in one commit.
export function fakeRunLoop(events: LoopEvent[] = [{ type: "done", reason: "no-tool-call" }]) {
  let captured: RunLoopOpts | undefined;
  async function* fake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
    captured = opts;
    for (const event of events) yield event;
    return opts.messages;
  }
  return { fake, capture: () => captured };
}
