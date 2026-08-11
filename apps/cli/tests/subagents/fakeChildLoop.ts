import type { LoopEvent, runLoop } from "../../src/loop/loop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

export type ChildCall = { opts: RunLoopOpts; startedAt: number; endedAt?: number };

// Not tests/cli/fakeRunLoop.ts: that fixture keeps a single last-call-wins `captured` and
// cli.test.ts/argv.test.ts depend on that shape. A dispatch fans out several children at once, so
// this records every call with start/end stamps and an optional concurrency barrier (`before`),
// which is what makes the parallelism proof in dispatch.test.ts deterministic rather than
// wall-clock.
export function fakeChildLoop(
  script: (
    opts: RunLoopOpts,
    index: number,
  ) => {
    events: LoopEvent[];
    before?: () => Promise<void>;
  },
) {
  const calls: ChildCall[] = [];
  let index = 0;

  async function* fake(opts: RunLoopOpts): AsyncGenerator<LoopEvent> {
    const call: ChildCall = { opts, startedAt: Date.now() };
    calls.push(call);
    const { events, before } = script(opts, index++);
    await before?.();
    for (const event of events) yield event;
    call.endedAt = Date.now();
  }

  return { fake, calls };
}
