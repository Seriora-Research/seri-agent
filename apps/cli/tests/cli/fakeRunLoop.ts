import type { LoopEvent, runLoop } from "../../src/loop/loop";

type RunLoopOpts = Parameters<typeof runLoop>[0];

export function fakeRunLoop(events: LoopEvent[] = [{ type: "done", reason: "no-tool-call" }]) {
  let captured: RunLoopOpts | undefined;
  async function* fake(opts: RunLoopOpts): AsyncGenerator<LoopEvent, RunLoopOpts["messages"]> {
    captured = opts;
    for (const event of events) yield event;
    return opts.messages;
  }
  return { fake, capture: () => captured };
}
