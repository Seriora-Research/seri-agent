import { describe, expect, test } from "bun:test";
import { createAskUserPark } from "../../src/ask-user/park";
import type { AskPrompt } from "../../src/ask-user/types";

const prompt: AskPrompt = {
  prompt: "Which auth?",
  choices: ["cookies", "JWT"],
  allowOther: true,
};

describe("createAskUserPark", () => {
  test("occupy then answer settles the waiter; a second answer is a no-op", async () => {
    const occupied: AskPrompt[] = [];
    let vacated = 0;
    const park = createAskUserPark({
      dispatchOccupy: (next) => occupied.push(next),
      dispatchVacate: () => {
        vacated += 1;
      },
      approvalOccupied: () => false,
    });
    const pending = park.present(prompt);
    expect(occupied).toEqual([prompt]);
    park.answer({ outcome: "picked", choice: "JWT" });
    park.answer({ outcome: "cancelled" });
    await expect(pending).resolves.toEqual({ outcome: "picked", choice: "JWT" });
    expect(vacated).toBe(1);
  });

  test("approvalOccupied refuses without occupying", async () => {
    let occupied = 0;
    const park = createAskUserPark({
      dispatchOccupy: () => {
        occupied += 1;
      },
      dispatchVacate: () => {},
      approvalOccupied: () => true,
    });
    await expect(park.present(prompt)).resolves.toEqual({
      outcome: "unavailable",
      reason: "nested-approval",
    });
    expect(occupied).toBe(0);
  });

  test("a second present while occupied does not steal the first waiter", async () => {
    const park = createAskUserPark({
      dispatchOccupy: () => {},
      dispatchVacate: () => {},
      approvalOccupied: () => false,
    });
    const first = park.present(prompt);
    const second = await park.present(prompt);
    expect(second).toEqual({ outcome: "unavailable", reason: "nested-approval" });
    park.answer({ outcome: "cancelled" });
    await expect(first).resolves.toEqual({ outcome: "cancelled" });
  });

  test("abort while occupied settles cancelled and vacates", async () => {
    let vacated = 0;
    const park = createAskUserPark({
      dispatchOccupy: () => {},
      dispatchVacate: () => {
        vacated += 1;
      },
      approvalOccupied: () => false,
    });
    const controller = new AbortController();
    const pending = park.present(prompt, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
    expect(vacated).toBe(1);
  });

  test("an already-aborted signal does not occupy", async () => {
    let occupied = 0;
    const park = createAskUserPark({
      dispatchOccupy: () => {
        occupied += 1;
      },
      dispatchVacate: () => {},
      approvalOccupied: () => false,
    });
    await expect(park.present(prompt, AbortSignal.abort())).resolves.toEqual({
      outcome: "unavailable",
      reason: "no-human",
    });
    expect(occupied).toBe(0);
  });
});
