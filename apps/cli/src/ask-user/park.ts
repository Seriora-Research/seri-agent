import { onAbort } from "../abort";
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
  let resolve: ((result: AskUserResult) => void) | undefined;

  function answer(reply: HumanReply): void {
    const ok = resolve;
    if (ok === undefined) return;
    resolve = undefined;
    deps.dispatchVacate();
    ok(reply);
  }

  async function present(prompt: AskPrompt, signal?: AbortSignal): Promise<AskUserResult> {
    if (deps.approvalOccupied()) return { outcome: "unavailable", reason: "nested-approval" };
    if (resolve !== undefined) return { outcome: "unavailable", reason: "nested-approval" };
    if (signal?.aborted === true) return { outcome: "cancelled" };
    return await new Promise<AskUserResult>((ok) => {
      let abort: ReturnType<typeof onAbort> | undefined;
      resolve = (result) => {
        abort?.dispose();
        ok(result);
      };
      abort = onAbort(signal, () => answer({ outcome: "cancelled" }));
      if (resolve === undefined) {
        abort.dispose();
        return;
      }
      deps.dispatchOccupy(prompt);
    });
  }

  return { present, answer };
}
