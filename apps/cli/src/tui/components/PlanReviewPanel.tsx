/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { PlanReviewDecision, SubmittedPlan } from "../../plan/mode";
import { theme } from "../theme/theme";
import { ListRow } from "../ui/ListRow";
import { OptionKeys } from "../ui/OptionKeys";
import { PanelBox } from "../ui/PanelBox";
import { isEnter } from "../util/keys";

const ACTIONS: readonly { id: PlanReviewDecision; label: string }[] = [
  { id: "approve", label: "Approve — leave plan mode and implement" },
  { id: "request-changes", label: "Request changes — stay in plan mode" },
  { id: "cancel", label: "Cancel — discard this plan file" },
];

export function PlanReviewPanel({
  plan,
  onDecision,
  onQuit,
}: {
  plan: SubmittedPlan;
  onDecision?: (decision: PlanReviewDecision) => void;
  onQuit?: () => void;
}) {
  const [selected, setSelected] = useState(0);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "d") {
      onQuit?.();
      return;
    }
    if (key.name === "escape") {
      onDecision?.("request-changes");
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;
      setSelected((current) => (current + delta + ACTIONS.length) % ACTIONS.length);
      return;
    }
    if (isEnter(key)) {
      const action = ACTIONS[selected];
      if (action !== undefined) onDecision?.(action.id);
    }
  });

  const preview = plan.markdown.split("\n").slice(0, 8).join("\n");

  return (
    <PanelBox title={`plan — ${plan.title}`} right="Esc request changes">
      <text fg={theme.muted}>{plan.path}</text>
      <text fg={theme.text}>{preview}</text>
      {ACTIONS.map((action, i) => (
        <ListRow key={action.id} selected={i === selected} label={action.label} />
      ))}
      <OptionKeys labels={["↑/↓ move", "Enter select", "Esc request changes"]} />
    </PanelBox>
  );
}
