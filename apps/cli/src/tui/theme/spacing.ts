import type { TranscriptKind, TranscriptRole } from "../util/format";
import { theme } from "./theme";

export const PAD_X = 1;

export const HAIRLINE_CHAR = "─";

export function hairlineRow(columns: number): string {
  return HAIRLINE_CHAR.repeat(Math.max(0, columns));
}

export const FRAME = {
  borderStyle: "single",
  borderColor: theme.border,
  paddingLeft: PAD_X,
  paddingRight: PAD_X,
} as const;

export const TOOL_INDENT = "  ";

const GAP_TABLE: Record<TranscriptRole, Record<TranscriptRole, 0 | 1>> = {
  user: { user: 1, assistant: 1, system: 1 },
  assistant: { user: 1, assistant: 0, system: 1 },
  system: { user: 1, assistant: 1, system: 0 },
};

export function gapBefore(
  prev: TranscriptRole | undefined,
  cur: TranscriptRole,
  prevKind?: TranscriptKind,
  curKind?: TranscriptKind,
): 0 | 1 {
  if (prev === undefined) return 0;
  if (prevKind === "reasoning" && cur === "assistant") return 0;
  if (prev === "assistant" && curKind === "reasoning") return 0;
  if (prev === "user" || cur === "user") return GAP_TABLE[prev]?.[cur] ?? GAP_TABLE.user[cur];
  if (
    prevKind === "file-change" ||
    curKind === "file-change" ||
    prevKind === "tool-summary" ||
    curKind === "tool-summary"
  ) {
    return 1;
  }
  if (prev === "assistant" && cur === "system" && curKind !== "reasoning") return 1;
  if (prev === "system" && cur === "assistant") return 1;
  return GAP_TABLE[prev][cur];
}
