import { describe, test } from "bun:test";
import { PLAN_MODE_OVERLAY } from "../../src/plan/prompt";
import { expectNoBashFirstSteer } from "../agents/bashFirstSteer";

describe("PLAN_MODE_OVERLAY", () => {
  test("does not steer file I/O onto bash", () => {
    expectNoBashFirstSteer(PLAN_MODE_OVERLAY);
  });
});
