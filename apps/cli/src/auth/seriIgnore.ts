import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "@seri/plans";
import { atomicWriteFile } from "../atomicWriteFile";
import { hasHostedAuth } from "./authStore";




export const SERI_IGNORE_FILENAME = "seri-ignore";

function ignorePath(configDir: string): string {
  return join(configDir, SERI_IGNORE_FILENAME);
}

export function isSeriIgnored(configDir: string): boolean {
  return existsSync(ignorePath(configDir));
}

export function ignoreSeriPlan(configDir: string): void {
  atomicWriteFile(ignorePath(configDir), "\n");
}

export function clearSeriIgnore(configDir: string): void {
  const path = ignorePath(configDir);
  if (existsSync(path)) unlinkSync(path);
}

export function hostedPlanUsable(configDir: string): boolean {
  return hasHostedAuth(configDir) && !isSeriIgnored(configDir);
}




export function effectiveHostedPlan(configDir: string, plan: Plan | null): Plan | null {
  if (plan === null || isSeriIgnored(configDir)) return null;
  return plan;
}

export function disconnectSeri(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  ignoreSeriPlan(configDir);
  onMessage("Disconnected seri plan. This profile will use your API keys; you stay logged in.");
}

export function reconnectSeri(
  configDir: string,
  onMessage: (message: string) => void = console.log,
): void {
  clearSeriIgnore(configDir);
  onMessage("Re-enabled seri plan for this profile.");
}

export type SeriSetupStatus =
  | { status: "not-logged-in" }
  | { status: "connected"; planType?: Plan }
  | { status: "ignored"; planType?: Plan };

export function describeSeriSetupStatus(status: SeriSetupStatus): string {
  switch (status.status) {
    case "not-logged-in":
      return "not connected";
    case "connected":
      return status.planType === undefined ? "connected" : `connected — ${status.planType}`;
    case "ignored":
      return "ignored — using your keys";
  }
}
