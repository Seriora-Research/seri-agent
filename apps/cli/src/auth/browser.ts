import { spawn as spawnReal } from "node:child_process";

// Only what a launcher actually touches, rather than ChildProcess: attach two listeners, unref,
// done. Typing the seam this narrowly is what lets a test hand back a plain object.
type LaunchedBrowser = {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  unref(): unknown;
};

export type BrowserLauncher = (
  executable: string,
  args: string[],
  options: { stdio: "ignore"; detached: boolean },
) => LaunchedBrowser;

function commandFor(url: string): [string, string[]] {
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

// Best-effort only: the printed verification_uri/user_code is always the primary path
// (per WorkOS's own device-flow guidance), so a failure to open a browser here is logged
// and swallowed rather than thrown.
//
// Deliberately not spawnCollect, which exists to capture a tool command's output under a
// timeout — a launcher wants neither. It resolves on "close", which waits for the stdio pipes
// rather than for the process, and a browser started by xdg-open inherits those pipes and holds
// them for as long as its window is open. Measured on Linux: `spawnCollect("/bin/sh", ["-c",
// "sleep 3 & echo started; exit 0"])` resolved after 3005 ms with the direct child long gone. So
// `login` printed the URL, hung for the full 120 s default timeout before it began polling for
// the token, and then killTree SIGKILLed the process group of the browser it had just opened.
export function openBrowser(url: string, spawnFn: BrowserLauncher = spawnReal): void {
  const [executable, args] = commandFor(url);
  const child = spawnFn(executable, args, {
    // Nothing inherited, so there is nothing left holding a pipe open once the launcher hands
    // off to the browser.
    stdio: "ignore",
    // Its own process group, so a Ctrl-C aimed at hesper does not close the user's browser.
    detached: process.platform !== "win32",
  });

  child.on("error", (error) => console.error(error.message));
  child.on("exit", (code) => {
    if (code !== 0) console.error(`Failed to open browser (exit code ${code})`);
  });
  // A browser outlives the run that opened it, and hesper must not wait on one to exit.
  child.unref();
}
