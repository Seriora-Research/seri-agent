import { describe, expect, test } from "bun:test";
import { executeAskUser, withAskUser } from "../../src/ask-user/tool";
import { ASK_USER_TOOL_NAME, type AskUserPresenter } from "../../src/ask-user/types";
import { toolDefinitions } from "../../src/provider/tools";

const valid = { prompt: "Which auth?", choices: ["cookies", "JWT"] };

async function raceUnavailable(
  run: Promise<unknown>,
): Promise<"done" | "timeout"> {
  return await Promise.race([
    run.then(() => "done" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
}

describe("executeAskUser", () => {
  test("a missing presenter fails closed without hanging and is not a cancel", async () => {
    const pending = executeAskUser(valid, undefined);
    expect(await raceUnavailable(pending)).toBe("done");
    const result = await pending;
    expect(result).toEqual({ outcome: "unavailable", reason: "no-human" });
    expect(result.outcome).not.toBe("cancelled");
  });

  test("an already-aborted signal fails closed without parking", async () => {
    let called = false;
    const presenter: AskUserPresenter = async () => {
      called = true;
      return { outcome: "cancelled" };
    };
    const result = await executeAskUser(valid, presenter, AbortSignal.abort());
    expect(called).toBe(false);
    expect(result).toEqual({ outcome: "unavailable", reason: "no-human" });
  });

  test("invalid input does not call the presenter", async () => {
    let called = false;
    const presenter: AskUserPresenter = async () => {
      called = true;
      return { outcome: "cancelled" };
    };
    const result = await executeAskUser({ prompt: "Q", choices: ["only"] }, presenter);
    expect(called).toBe(false);
    expect(result.outcome).toBe("invalid");
  });

  test("a listed pick passes through; a mismatched other is invalid", async () => {
    const picked = await executeAskUser(valid, async () => ({
      outcome: "picked",
      choice: "JWT",
    }));
    expect(picked).toEqual({ outcome: "picked", choice: "JWT" });

    const other = await executeAskUser(
      { ...valid, allowOther: false },
      async () => ({ outcome: "other", text: "x" }),
    );
    expect(other.outcome).toBe("invalid");
  });
});

describe("withAskUser", () => {
  test("adds ask_user without copying it onto toolDefinitions", () => {
    const tools = withAskUser(toolDefinitions, undefined);
    expect(ASK_USER_TOOL_NAME in tools).toBe(true);
    expect(Object.keys(toolDefinitions)).not.toContain(ASK_USER_TOOL_NAME);
  });
});
