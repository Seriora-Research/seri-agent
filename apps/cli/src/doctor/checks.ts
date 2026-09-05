import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@seri/daemon-client";
import { hostedPlanUsable } from "../auth/seriIgnore";
import { isGitAvailable } from "../checkpoint/shadowGit";
import { inspectConfig, loadSandboxConfig } from "../config/config";
import { DATABASE_FILENAME, getConfigDir, currentProfile, resolveUserHome } from "../config/paths";
import { readDaemonDescriptorFile } from "../daemon/descriptor";
import { looksLikeSeriBinary } from "../installIdentity";
import { loadGrants } from "../permissions/store";
import { allProviderKeyStates } from "../provider/keys";
import { subscribedProviders } from "../provider/subscriptions";
import { probeConfinement } from "../sandbox/confine";
import { type IoUringProbe, ioUringDoctorCheck, probeIoUringSetup } from "../sandbox/ioUring";
import {
  formatSandboxDoctorDetail,
  idleSandboxTier,
  resolveShellLaunch,
} from "../sandbox/policy";
import { SessionDatabase } from "../session/database";
import { isBashAvailable } from "../tools/bash";
import type { grep as GrepFn } from "../tools/grep";
import { probeRipgrep } from "../tools/selftest";
import { harnessId } from "../trajectory/harnessId";
import type { CheckResult } from "./report";

export type DoctorDeps = {
  grep: typeof GrepFn;
  fetch: typeof fetch;
  execPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  configDir?: string;
  probeIoUring?: () => IoUringProbe;
};

export async function runDoctorChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const configDir = deps.configDir ?? getConfigDir();
  return [
    binaryCheck(deps),
    await ripgrepCheck(deps),
    profileCheck(configDir),
    homeCheck(deps),
    configCheck(configDir),
    credentialsCheck(configDir),
    permissionsCheck(configDir, deps.cwd),
    catalogCheck(deps.env),
    gitCheck(),
    bashCheck(),
    sandboxCheck(configDir, deps.cwd, deps.platform),
    sessionStoreCheck(configDir),
    await daemonCheck(configDir, deps.fetch),
    ioUringDoctorCheck((deps.probeIoUring ?? probeIoUringSetup)(), deps.platform),
  ];
}

function binaryCheck(deps: DoctorDeps): CheckResult {
  const id = harnessId(deps.env);
  const commit = id.commit === undefined ? "" : ` ${id.commit.slice(0, 7)}`;
  const kind = looksLikeSeriBinary(deps.execPath) ? "compiled" : "source";
  return {
    name: "binary",
    status: "ok",
    detail: `seri ${id.version}${commit} ${deps.platform} ${deps.arch} ${kind} ${deps.execPath}`,
  };
}

async function ripgrepCheck(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const version = await probeRipgrep(deps.grep);
    return { name: "ripgrep", status: "ok", detail: version };
  } catch (error) {
    return {
      name: "ripgrep",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "reinstall the seri binary for this OS",
    };
  }
}

function profileCheck(configDir: string): CheckResult {
  const { profile, source } = currentProfile();
  return {
    name: "profile",
    status: "ok",
    detail: `${profile} (${source}) ${configDir}`,
  };
}

function homeCheck(deps: DoctorDeps): CheckResult {
  const home = resolveUserHome(deps.env, deps.platform);
  if (deps.platform === "win32") {
    const posixHome = deps.env.HOME;
    const userProfile = deps.env.USERPROFILE || homedir();
    if (posixHome !== undefined && posixHome.startsWith("/") && posixHome !== userProfile) {
      return {
        name: "home",
        status: "warn",
        detail: `HOME=${posixHome} is POSIX-shaped; config uses ${home}, install.ps1 uses ${userProfile}`,
        fix: "unset HOME or set it to %USERPROFILE% so the binary and config share a root",
      };
    }
  }
  return { name: "home", status: "ok", detail: home };
}

function configCheck(configDir: string): CheckResult {
  if (existsSync(configDir)) {
    try {
      accessSync(configDir, constants.W_OK);
    } catch {
      return {
        name: "config",
        status: "fail",
        detail: `${configDir} is not writable`,
        fix: "chmod the profile directory so seri can write config.json",
      };
    }
  }
  const inspected = inspectConfig(configDir);
  if (inspected.status === "missing") {
    return { name: "config", status: "info", detail: "config.json is absent" };
  }
  if (inspected.status === "malformed") {
    return {
      name: "config",
      status: "fail",
      detail:
        inspected.reason === "unreadable"
          ? "config.json is not JSON"
          : "config.json is not an object",
      fix: "rewrite config.json or delete it and run /setup",
    };
  }
  return { name: "config", status: "ok", detail: `${Object.keys(inspected.values).length} keys` };
}

function credentialsCheck(configDir: string): CheckResult {
  const keys = allProviderKeyStates(configDir).filter((row) => row.source !== "unset");
  const keyPart =
    keys.length === 0
      ? "no BYOK keys"
      : keys.map((row) => `${row.provider}=${row.source}:${row.masked}`).join(" ");
  const subs = [...subscribedProviders(configDir)];
  const hosted = hostedPlanUsable(configDir);
  const extra = [
    subs.length === 0 ? undefined : `subscriptions=${subs.join(",")}`,
    hosted ? "hosted=yes" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const detail = extra.length === 0 ? keyPart : `${keyPart} ${extra}`;
  if (keys.length === 0 && subs.length === 0 && !hosted) {
    return {
      name: "credentials",
      status: "fail",
      detail,
      fix: "run seri and complete /setup, or set a provider API key",
    };
  }
  return { name: "credentials", status: "ok", detail };
}

function permissionsCheck(configDir: string, cwd: string): CheckResult {
  const warnings: string[] = [];
  const grants = loadGrants(configDir, cwd, (message) => warnings.push(message));
  if (warnings.length > 0) {
    return {
      name: "permissions",
      status: "fail",
      detail: warnings[0] ?? "permissions.yaml is malformed",
      fix: "fix or delete permissions.yaml",
    };
  }
  const n = grants.global.length + grants.project.length;
  return { name: "permissions", status: "ok", detail: `${n} grants` };
}

function catalogCheck(env: NodeJS.ProcessEnv): CheckResult {
  if (env.SERI_DISABLE_MODELS_FETCH) {
    return {
      name: "catalog",
      status: "info",
      detail: "models.dev fetch disabled; bundled catalog will be used",
    };
  }
  return {
    name: "catalog",
    status: "info",
    detail: "not probed; first turn fetches models.dev or uses the bundled catalog",
  };
}

function gitCheck(): CheckResult {
  return isGitAvailable()
    ? { name: "git", status: "ok", detail: "available" }
    : {
        name: "git",
        status: "warn",
        detail: "git is not on PATH",
        fix: "install git to enable checkpoints and /undo",
      };
}

function bashCheck(): CheckResult {
  return isBashAvailable()
    ? { name: "bash", status: "ok", detail: "available" }
    : {
        name: "bash",
        status: "warn",
        detail: "bash is not on PATH",
        fix: "install bash or Git Bash to use the bash tool",
      };
}

function sessionStoreCheck(configDir: string): CheckResult {
  const path = join(configDir, DATABASE_FILENAME);
  if (!existsSync(path)) {
    return { name: "sessions", status: "info", detail: "seri.db is absent" };
  }
  let database: SessionDatabase | undefined;
  try {
    database = new SessionDatabase(configDir);
    const count = database.listSessionIds().length;
    return { name: "sessions", status: "ok", detail: `${count} in ${path}` };
  } catch (error) {
    return {
      name: "sessions",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "move seri.db aside if it is corrupt",
    };
  } finally {
    database?.close();
  }
}

async function daemonCheck(configDir: string, fetchFn: typeof fetch): Promise<CheckResult> {
  const descriptor = readDaemonDescriptorFile(configDir);
  if (descriptor === undefined) {
    return { name: "daemon", status: "info", detail: "not running" };
  }
  try {
    const client = new DaemonClient({
      endpoint: descriptor.endpoint,
      token: descriptor.token,
      fetch: fetchFn,
    });
    const health = await client.health();
    return { name: "daemon", status: "ok", detail: `pid ${health.pid} ${descriptor.endpoint}` };
  } catch (error) {
    return {
      name: "daemon",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      fix: "remove the stale daemon.json or start a new one with seri serve",
    };
  }
}

function sandboxCheck(configDir: string, cwd: string, platform: NodeJS.Platform): CheckResult {
  const { allowUnsandboxedCommands } = loadSandboxConfig(configDir);
  const confinement = { available: probeConfinement(platform) };
  const idle = idleSandboxTier(confinement, allowUnsandboxedCommands);
  const bang = resolveShellLaunch(
    "bang",
    { allowUnsandboxedCommands, root: cwd },
    confinement,
  );
  const detail = formatSandboxDoctorDetail(idle, bang, allowUnsandboxedCommands);
  if (bang.kind === "refused") {
    return {
      name: "sandbox",
      status: "warn",
      detail,
      fix: "set SERI_ALLOW_UNSANDBOXED_COMMANDS or wait for OS sandbox support",
    };
  }
  if (bang.kind === "unsandboxed") {
    return {
      name: "sandbox",
      status: "warn",
      detail,
      fix: "set SERI_ALLOW_UNSANDBOXED_COMMANDS=false to keep ! inside the OS sandbox",
    };
  }
  if (idle === "os") {
    return { name: "sandbox", status: "ok", detail };
  }
  return { name: "sandbox", status: "info", detail };
}

function sessionStoreCheck(configDir: string): CheckResult {
  const path = join(configDir, DATABASE_FILENAME);
  if (!existsSync(path)) {
    return { name: "sessions", status: "info", detail: "seri.db is absent" };
  }
  let database: SessionDatabase | undefined;
  try {
    database = new SessionDatabase(configDir);
    const count = database.listSessionIds().length;
    return { name: "sessions", status: "ok", detail: `${count} in ${path}` };
  } catch (error) {
    return {
      name: "sessions",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "move seri.db aside if it is corrupt",
    };
  } finally {
    database?.close();
  }
}

async function daemonCheck(configDir: string, fetchFn: typeof fetch): Promise<CheckResult> {
  const descriptor = readDaemonDescriptorFile(configDir);
  if (descriptor === undefined) {
    return { name: "daemon", status: "info", detail: "not running" };
  }
  try {
    const client = new DaemonClient({
      endpoint: descriptor.endpoint,
      token: descriptor.token,
      fetch: fetchFn,
    });
    const health = await client.health();
    return { name: "daemon", status: "ok", detail: `pid ${health.pid} ${descriptor.endpoint}` };
  } catch (error) {
    return {
      name: "daemon",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      fix: "remove the stale daemon.json or start a new one with seri serve",
    };
  }
}
