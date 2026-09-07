







import type { FileChangeView } from "../fileChange";
import type { Diagnostic } from "./parse";

export type CheckOutcome =
  | { status: "ok"; command: string; elapsedMs: number }
  | {
      status: "diagnostics";
      command: string;
      elapsedMs: number;





      diagnostics: Diagnostic[];
      inWrittenFile: number;




      truncated: boolean;


      total: number;
    }

  | { status: "unavailable"; reason: string }



  | { status: "failed"; reason: string };





export type WriteFileResult = {
  written: true;
  verification: CheckOutcome;
  change?: FileChangeView;
};






export function writeFileVerification(result: unknown): CheckOutcome | undefined {
  const verification = (result as Partial<WriteFileResult> | null | undefined)?.verification;
  return typeof verification?.status === "string" ? verification : undefined;
}
