import { spawn as spawnReal } from "node:child_process";



type LaunchedBrowser = {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  unref(): unknown;
};

export type BrowserLauncher = (
  executable: string,
  args: string[],
  options: { stdio: "ignore"; detached: boolean; windowsVerbatimArguments?: boolean },
) => LaunchedBrowser;














function commandFor(url: string): [string, string[]] {
  if (process.platform === "win32") return ["cmd", ["/c", "start", '""', `"${url}"`]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}












export function openBrowser(url: string, spawnFn: BrowserLauncher = spawnReal): void {
  const [executable, args] = commandFor(url);
  const child = spawnFn(executable, args, {


    stdio: "ignore",

    detached: process.platform !== "win32",



    // cmd.exe splits on bare `&`; Node's escaping eats quotes unless windowsVerbatimArguments keeps them.
    windowsVerbatimArguments: process.platform === "win32",
  });

  child.on("error", (error) => console.error(error.message));
  child.on("exit", (code) => {
    if (code !== 0) console.error(`Failed to open browser (exit code ${code})`);
  });

  child.unref();
}
