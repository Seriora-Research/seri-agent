import { homedir } from "node:os";

// On Windows a POSIX HOME (/c/Users/name, /home/user) is not %USERPROFILE%.
// Node's win32 join treats it as a drive-relative path. Codex writes under
// FOLDERID_Profile, which os.homedir() already returns without reading HOME.
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
