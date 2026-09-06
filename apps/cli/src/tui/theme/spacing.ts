import type { TranscriptRole } from "../util/format";
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
  assistant: { user: 1, assistant: 0, system: 0 },
  system: { user: 1, assistant: 0, system: 0 },
};

export function gapBefore(prev: TranscriptRole | undefined, cur: TranscriptRole): 0 | 1 {
  if (prev === undefined) return 0;
  return GAP_TABLE[prev][cur];
}
