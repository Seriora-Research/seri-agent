export type CheckStatus = "ok" | "warn" | "fail" | "info";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

export function doctorExitCode(checks: readonly CheckResult[]): 0 | 1 {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export function formatDoctorReport(checks: readonly CheckResult[]): string {
  return checks
    .map((check) => {
      const tag = check.status.padEnd(4);
      const name = check.name.padEnd(12);
      const line = `${tag} ${name} ${check.detail}`;
      return check.fix === undefined ? line : `${line}\n             ${check.fix}`;
    })
    .join("\n");
}

export function printDoctorReport(checks: readonly CheckResult[]): void {
  console.log(formatDoctorReport(checks));
}
