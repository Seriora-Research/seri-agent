import { homedir } from "node:os";

// On Windows a POSIX HOME is not %USERPROFILE%; Node's win32 join treats it as drive-relative. Codex writes under FOLDERID_Profile, which os.homedir() returns without reading HOME.
export function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const home = env.HOME;
  if (platform === "win32") {
    if (home !== undefined && !home.startsWith("/")) return home;
    return env.USERPROFILE || homedir();
  }
  return home || homedir();
}
