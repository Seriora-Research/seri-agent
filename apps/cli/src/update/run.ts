import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { looksLikeSeriBinary } from "../installIdentity";
import { messageOf } from "../errors";

export const RELEASE_REPO = "Seriora-Research/seri-agent";

export type UpdateResult = {
  code: 0 | 1;
  lines: string[];
};

export type UpdateDeps = {
  fetch: typeof fetch;
  execPath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  smoke?: (binaryPath: string) => Promise<void>;
};

export function releaseAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "win32") {
    if (arch !== "x64") return undefined;
    return "seri-windows-x64.exe";
  }
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  return `seri-${os}-${cpu}`;
}

export function stripReleaseTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function checksumForAsset(sums: string, asset: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (match !== null && match[2] === asset) return match[1].toLowerCase();
  }
  return undefined;
}

export async function runUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  if (!looksLikeSeriBinary(deps.execPath)) {
    return {
      code: 1,
      lines: ["running from source; update with git, or install a release binary"],
    };
  }
  const asset = releaseAssetName(deps.platform, deps.arch);
  if (asset === undefined) {
    return {
      code: 1,
      lines: [`no prebuilt binary for ${deps.platform}/${deps.arch}`],
    };
  }

  const pin = deps.env.SERI_VERSION?.trim();
  let tag: string;
  try {
    tag = pin && pin.length > 0 ? (pin.startsWith("v") ? pin : `v${pin}`) : await fetchLatestTag(deps);
  } catch (error) {
    return { code: 1, lines: [messageOf(error)] };
  }
  const remoteVersion = stripReleaseTag(tag);
  if (remoteVersion === deps.version) {
    return { code: 0, lines: [`seri ${deps.version} is current`] };
  }

  const base = `https://github.com/${RELEASE_REPO}/releases/download/${tag}`;
  let bytes: Uint8Array;
  let sums: string;
  try {
    bytes = await downloadBytes(deps.fetch, `${base}/${asset}`);
    sums = await downloadText(deps.fetch, `${base}/SHA256SUMS`);
  } catch (error) {
    return { code: 1, lines: [messageOf(error)] };
  }
  const expected = checksumForAsset(sums, asset);
  if (expected === undefined) {
    return { code: 1, lines: [`SHA256SUMS in ${tag} does not list ${asset}`] };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    return {
      code: 1,
      lines: [`checksum mismatch for ${asset}`, `  expected ${expected}`, `  got      ${actual}`],
    };
  }

  const tmpPath = `${deps.execPath}.update`;
  const backupPath = `${deps.execPath}.old`;
  try {
    writeFileSync(tmpPath, bytes);
    if (deps.platform !== "win32") chmodSync(tmpPath, 0o755);
    const smoke = deps.smoke ?? defaultSmoke;
    await smoke(tmpPath);
    try {
      unlinkSync(backupPath);
    } catch {
      // no leftover .old from a previous Windows replace
    }
    renameSync(deps.execPath, backupPath);
    try {
      renameSync(tmpPath, deps.execPath);
    } catch (error) {
      renameSync(backupPath, deps.execPath);
      throw error;
    }
    try {
      unlinkSync(backupPath);
    } catch {
      // Windows may keep the running image until the next start
    }
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp already gone or never created
    }
    return { code: 1, lines: [messageOf(error)] };
  }
  return {
    code: 0,
    lines: [`updated seri ${deps.version} → ${remoteVersion}`, deps.execPath],
  };
}

async function fetchLatestTag(deps: UpdateDeps): Promise<string> {
  const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const response = await deps.fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `seri/${deps.version}` },
  });
  if (response.status === 404) {
    throw new Error("no GitHub release yet; tag v* on main after merge");
  }
  if (!response.ok) {
    throw new Error(`GitHub releases returned ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("tag_name" in body)) {
    throw new Error("GitHub latest release JSON is missing tag_name");
  }
  const tagName = (body as { tag_name: unknown }).tag_name;
  if (typeof tagName !== "string" || tagName.length === 0) {
    throw new Error("GitHub latest release JSON is missing tag_name");
  }
  if ("prerelease" in body && (body as { prerelease: unknown }).prerelease === true) {
    throw new Error("latest GitHub release is a prerelease; pin SERI_VERSION to a stable tag");
  }
  return tagName;
}

async function downloadBytes(fetchFn: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadText(fetchFn: typeof fetch, url: string): Promise<string> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
  return await response.text();
}

async function defaultSmoke(binaryPath: string): Promise<void> {
  const version = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (version.status !== 0) {
    throw new Error(`new binary --version failed: ${version.stderr || version.stdout}`);
  }
  const selftest = spawnSync(binaryPath, ["--selftest"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (selftest.status !== 0) {
    throw new Error(`new binary --selftest failed: ${selftest.stderr || selftest.stdout}`);
  }
}

