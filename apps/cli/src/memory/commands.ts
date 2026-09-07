import { setConfigValue } from "../config/config";
import { truncate } from "../truncate";
import {
  approvePending,
  diffPending,
  listPending,
  type PendingWrite,
  pendingLabel,
  rejectPending,
  resolvePendingRef,
} from "./pending";

export type MemoryCommandDeps = { configDir: string };






export type MemoryLine = { text: string; muted?: boolean };



export type MemoryPanelRow = {
  id: string;
  action: PendingWrite["action"];

  file: string;

  detail: string;
  reason: string;
  durable: boolean;
};





const SHORT_ID = 7;
const ACTION_WIDTH = 8;
const FILE_WIDTH = 22;



function column(value: string, width: number): string {
  return truncate(value, width - 1).padEnd(width);
}

function writeDetail(p: PendingWrite): string {
  if (p.action === "add") return p.content ?? "";
  if (p.action === "remove") return p.target ?? "";
  return `${truncate(p.target ?? "", 40)} → ${truncate(p.content ?? "", 40)}`;
}






function summaryLine(p: PendingWrite): MemoryLine {
  return {
    text: `${p.id.slice(0, SHORT_ID)}  ${column(p.action, ACTION_WIDTH)}${column(pendingLabel(p), FILE_WIDTH)}${truncate(writeDetail(p), 60)}`,
  };
}




export function memoryPanelRows(deps: MemoryCommandDeps): MemoryPanelRow[] {
  return listPending(deps.configDir).map((p) => ({
    id: p.id,
    action: p.action,
    file: pendingLabel(p),
    detail: writeDetail(p),
    reason: p.reason,
    durable: p.durable,
  }));
}




export function memoryDiffLines(deps: MemoryCommandDeps, id: string): string[] {
  return forEachMatch(
    deps.configDir,
    id,
    "diff",
    false,
    (p) => diffPending(deps.configDir, p).lines,
  ).map((line) => line.text);
}

const ID_ARG_RE = /^(all|[0-9a-f]{4,40})$/;
const ON_OFF_RE = /^(on|off)$/;





export function memoryCommandAccepts(args: string[]): boolean {
  const [sub, ...rest] = args;


  if (sub === undefined || sub === "list" || sub === "pending") return rest.length === 0;



  if (sub === "diff" || sub === "approve" || sub === "reject")
    return rest.length === 1 && ID_ARG_RE.test(rest[0] ?? "");
  if (sub === "approval" || sub === "archivist")
    return rest.length === 1 && ON_OFF_RE.test(rest[0] ?? "");
  return false;
}










function forEachMatch(
  configDir: string,
  ref: string,
  verb: string,
  separateEntries: boolean,
  act: (p: PendingWrite) => string[],
): MemoryLine[] {
  const matches = resolvePendingRef(configDir, ref);
  if (matches.length === 0) return [{ text: `No staged write matches "${ref}".` }];
  const lines: MemoryLine[] = [];
  for (const p of matches) {
    try {
      lines.push(...act(p).map((text) => ({ text })));
    } catch (err) {
      lines.push({
        text: `Could not ${verb} ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (separateEntries) lines.push({ text: "" });
  }
  return lines;
}






function countedResult(
  configDir: string,
  ref: string,
  verb: string,
  pastTense: string,
  act: (p: PendingWrite) => void,
): { lines: MemoryLine[] } {
  const matches = resolvePendingRef(configDir, ref);
  if (matches.length === 0) return { lines: [{ text: `No staged write matches "${ref}".` }] };
  const failures: MemoryLine[] = [];
  let done = 0;
  for (const p of matches) {
    try {
      act(p);
      done += 1;
    } catch (err) {
      failures.push({
        text: `Could not ${verb} ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const counted: MemoryLine[] =
    done === 0 ? [] : [{ text: `${done} ${done === 1 ? "memory" : "memories"} ${pastTense}.` }];
  return { lines: [...counted, ...failures] };
}

const USAGE =
  "Usage: /memory | pending | diff <id|all> | approve <id|all> | reject <id|all> | approval on|off | archivist on|off";




export function decideMemoryCommand(
  args: string[],
  deps: MemoryCommandDeps,
): { lines: MemoryLine[] } {
  const [sub, ...rest] = args;




  if (sub === undefined || sub === "list" || sub === "pending") {
    const pending = listPending(deps.configDir);
    if (pending.length === 0) return { lines: [{ text: "No staged memory writes.", muted: true }] };
    return {
      lines: [
        ...pending.map(summaryLine),
        { text: "/memory diff <id> · approve <id|all> · reject <id|all>", muted: true },
      ],
    };
  }

  if (sub === "diff" && rest.length === 1) {


    return {
      lines: forEachMatch(
        deps.configDir,
        rest[0] as string,
        "diff",
        true,
        (p) => diffPending(deps.configDir, p).lines,
      ),
    };
  }

  if (sub === "approve" && rest.length === 1) {
    return countedResult(deps.configDir, rest[0] as string, "approve", "approved", (p) => {
      approvePending(deps.configDir, p);
    });
  }

  if (sub === "reject" && rest.length === 1) {


    return countedResult(deps.configDir, rest[0] as string, "reject", "rejected", (p) => {
      rejectPending(deps.configDir, p);
    });
  }

  if (sub === "approval" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_MEMORY_APPROVAL", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [{ text: `Memory approval gate is now ${rest[0]}.` }] };
  }

  if (sub === "archivist" && ON_OFF_RE.test(rest[0] ?? "")) {
    setConfigValue("SERI_ARCHIVIST_ENABLED", rest[0] === "on" ? "true" : "false", deps.configDir);
    return { lines: [{ text: `Archivist is now ${rest[0]}.` }] };
  }

  return { lines: [{ text: USAGE, muted: true }] };
}
