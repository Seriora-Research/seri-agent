export type PlanQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly string[];
};

export type PlanAnswers =
  | { readonly cancelled: true }
  | {
      readonly cancelled?: false;
      readonly answers: readonly { questionId: string; choice: string }[];
      readonly notes?: string;
    };

export type SubmittedPlan = {
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
};

export type PlanReviewDecision = "approve" | "request-changes" | "cancel";

export function isSubmittedPlan(value: unknown): value is SubmittedPlan {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.path === "string" &&
    typeof rec.title === "string" &&
    typeof rec.markdown === "string"
  );
}

export type PlanOverlay =
  | { readonly kind: "off" }
  | { readonly kind: "on" }
  | { readonly kind: "clarifying"; readonly questions: readonly PlanQuestion[] }
  | ({ readonly kind: "reviewing" } & SubmittedPlan);

export const PLAN_OVERLAY_OFF: PlanOverlay = { kind: "off" };

export function isPlanOverlayOn(plan: PlanOverlay): boolean {
  return plan.kind !== "off";
}

export function isPlanPanelOpen(plan: PlanOverlay): boolean {
  return plan.kind === "clarifying" || plan.kind === "reviewing";
}
