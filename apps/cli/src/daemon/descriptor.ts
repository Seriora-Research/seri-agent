import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { DaemonDescriptor } from "@seri/daemon-client";
import { atomicWriteFile, ensureOwnerOnlyDir } from "../atomicWriteFile";
import { getDaemonDescriptorPath, getDaemonLockPath } from "../config/paths";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`a daemon is already running for this profile (pid ${pid})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export type AcquiredDaemonLock = {
  path: string;
  release: () => void;
};

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function recoverStale(configDir: string): void {
  const lockPath = getDaemonLockPath(configDir);
  const descriptorPath = getDaemonDescriptorPath(configDir);
  const lockPid = readPid(lockPath);
  if (lockPid !== undefined && pidIsAlive(lockPid)) {
    throw new DaemonAlreadyRunningError(lockPid);
  }
  if (existsSync(descriptorPath)) {
    try {
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as DaemonDescriptor;
      if (typeof descriptor.pid === "number" && pidIsAlive(descriptor.pid)) {
        throw new DaemonAlreadyRunningError(descriptor.pid);
      }
    } catch (error) {
      if (error instanceof DaemonAlreadyRunningError) throw error;
    }
  }
  removeIfPresent(lockPath);
  removeIfPresent(descriptorPath);
}

export function acquireDaemonLock(configDir: string): AcquiredDaemonLock {
  ensureOwnerOnlyDir(configDir);
  const path = getDaemonLockPath(configDir);
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    recoverStale(configDir);
    fd = openSync(path, "wx");
  }
  writeSync(fd, `${process.pid}\n`);
  return {
    path,
    release: () => {
      closeSync(fd);
      removeIfPresent(path);
    },
  };
}

export function writeDaemonDescriptor(configDir: string, descriptor: DaemonDescriptor): void {
  atomicWriteFile(getDaemonDescriptorPath(configDir), `${JSON.stringify(descriptor, null, 2)}\n`);
}

export function readDaemonDescriptorFile(configDir: string): DaemonDescriptor | undefined {
  const path = getDaemonDescriptorPath(configDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DaemonDescriptor;
}

export function removeOwnedDescriptor(configDir: string, token: string): void {
  const current = readDaemonDescriptorFile(configDir);
  if (current === undefined) return;
  if (current.token !== token) return;
  removeIfPresent(getDaemonDescriptorPath(configDir));
}
