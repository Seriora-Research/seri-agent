import { abortedError, onAbort } from "../abort";
import type { AskPrompt, AskUserPresenter, AskUserResult, HumanReply } from "./types";

export type AskUserPark = {
  readonly present: AskUserPresenter;
  readonly answer: (reply: HumanReply) => void;
};

export type AskUserParkDeps = {
  dispatchOccupy: (prompt: AskPrompt) => void;
  dispatchVacate: () => void;
  approvalOccupied: () => boolean;
};

export function createAskUserPark(deps: AskUserParkDeps): AskUserPark {
  let settle:
    | { resolve: (result: AskUserResult) => void; reject: (err: unknown) => void }
    | undefined;

  function answer(reply: HumanReply): void {
    const waiting = settle;
    if (waiting === undefined) return;
    settle = undefined;
    deps.dispatchVacate();
    waiting.resolve(reply);
  }

  async function present(prompt: AskPrompt, signal?: AbortSignal): Promise<AskUserResult> {
    if (deps.approvalOccupied()) return { outcome: "unavailable", reason: "nested-approval" };
    if (settle !== undefined) return { outcome: "unavailable", reason: "nested-approval" };
    if (signal?.aborted === true) throw abortedError(signal);
    return await new Promise<AskUserResult>((ok, fail) => {
      let abort: ReturnType<typeof onAbort> | undefined;
      settle = {
        resolve: (result) => {
          abort?.dispose();
          ok(result);
        },
        reject: (err) => {
          abort?.dispose();
          fail(err);
        },
      };
      abort = onAbort(signal, () => {
        if (signal === undefined) return;
        const waiting = settle;
        settle = undefined;
        if (waiting === undefined) return;
        abort?.dispose();
        deps.dispatchVacate();
        fail(abortedError(signal));
      });
      if (settle === undefined) {
        abort.dispose();
        return;
      }
      deps.dispatchOccupy(prompt);
    });
  }

  return { present, answer };
}
