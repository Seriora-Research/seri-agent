import type { PermissionMode } from "../../gate/gate";

const MUTED = "#8F8D85";
const INK = "#e8e4d8";
const ACCENT = "#e8b86d";
const ON_INK = "#0c0c0b";

export const theme = {
  text: INK,
  error: "white",
  warning: "white",
  muted: MUTED,
  userBg: "#3E3E3A",
  selectedBg: ACCENT,
  selectedFg: ON_INK,
  accent: ACCENT,
  onInk: ON_INK,
  mode: {
    "read-only": "#8ab4c8",
    "approve-each": MUTED,
    auto: "#cc8a6a",
  } satisfies Record<PermissionMode, string>,
  code: "#9fc5e8",
  quotaExhausted: "#e05050",
  diffAdd: "#3fb950",
  diffDel: "#f85149",
  border: INK,
} as const;

export const ERROR_MARK = "✕ ";
export const WARNING_MARK = "! ";
export const TREE_BRANCH = "└ ";
export const TREE_MID = "├ ";
export const ARCHIVIST_MARK = "· ";
