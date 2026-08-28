import type { PermissionMode } from "../gate/gate";
import type { ApprovalPrompt } from "../loop/loop";

export type RunPolicy =
  | {
      origin: "attended";
      permissionMode: PermissionMode;
      allowedTools: readonly string[];
      approvalPrompt?: ApprovalPrompt;
    }
  | {
      origin: "scheduled";
      permissionMode: "read-only";
      allowedTools: readonly [];
      approvalPrompt?: never;
    };
