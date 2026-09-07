import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserLauncher } from "../../src/auth/browser";
import { openBrowser } from "../../src/auth/browser";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}



function fakeLauncher() {
  const seen: {
    executable?: string;
    args?: string[];
    options?: { stdio: "ignore"; detached: boolean; windowsVerbatimArguments?: boolean };
    unrefs: number;
  } = { unrefs: 0 };
  let onError: ((error: Error) => void) | undefined;
  let onExit: ((code: number | null) => void) | undefined;

  const spawnFn: BrowserLauncher = (executable, args, options) => {
    seen.executable = executable;
    seen.args = args;
    seen.options = options;
    return {
      on(event: string, listener: unknown) {
        if (event === "error") onError = listener as (error: Error) => void;
        else onExit = listener as (code: number | null) => void;
      },
      unref() {
        seen.unrefs += 1;
      },
    };
  };

  return {
    spawnFn,
    seen,
    launched: () => ({ executable: seen.executable, args: seen.args }),
    fireError: (error: Error) => onError?.(error),
    fireExit: (code: number | null) => onExit?.(code),
  };
}


function captureConsoleError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  return { errors, restore: () => (console.error = originalError) };
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("openBrowser", () => {
  test("win32 launches via cmd /c start", () => {
    setPlatform("win32");
    const launcher = fakeLauncher();

    openBrowser("https://example.com/device", launcher.spawnFn);

    expect(launcher.launched()).toEqual({
      executable: "cmd",
      args: ["/c", "start", '""', '"https://example.com/device"'],
    });
  });








  test("win32 keeps a URL whose parameters are joined by & in one argument", () => {
    setPlatform("win32");
    const launcher = fakeLauncher();
    const url =
      "https://api.supabase.com/v1/oauth/authorize?response_type=code&client_id=a&state=b";

    openBrowser(url, launcher.spawnFn);


    expect(launcher.seen.args?.at(-1)).toBe(`"${url}"`);
    expect(launcher.seen.args).toHaveLength(4);


    expect(launcher.seen.options?.windowsVerbatimArguments).toBe(true);
  });

  test("a non-Windows launcher passes the URL as one bare argument", () => {
    setPlatform("darwin");
    const launcher = fakeLauncher();
    const url = "https://api.supabase.com/v1/oauth/authorize?response_type=code&client_id=a";

    openBrowser(url, launcher.spawnFn);



    expect(launcher.launched()).toEqual({ executable: "open", args: [url] });
    expect(launcher.seen.options?.windowsVerbatimArguments).toBe(false);
  });

  test("darwin launches via open", () => {
    setPlatform("darwin");
    const launcher = fakeLauncher();

    openBrowser("https://example.com/device", launcher.spawnFn);

    expect(launcher.launched()).toEqual({
      executable: "open",
      args: ["https://example.com/device"],
    });
  });

  test("other platforms launch via xdg-open", () => {
    setPlatform("linux");
    const launcher = fakeLauncher();

    openBrowser("https://example.com/device", launcher.spawnFn);

    expect(launcher.launched()).toEqual({
      executable: "xdg-open",
      args: ["https://example.com/device"],
    });
  });

  test("swallows a spawn failure instead of throwing", () => {
    setPlatform("linux");
    const launcher = fakeLauncher();
    const console = captureConsoleError();

    try {
      openBrowser("https://example.com/device", launcher.spawnFn);


      expect(() => launcher.fireError(new Error("no such command"))).not.toThrow();
    } finally {
      console.restore();
    }

    expect(console.errors).toEqual(["no such command"]);
  });

  test("reports a non-zero exit code instead of treating it as success", () => {
    setPlatform("linux");
    const launcher = fakeLauncher();
    const console = captureConsoleError();

    try {
      openBrowser("https://example.com/device", launcher.spawnFn);
      launcher.fireExit(1);
    } finally {
      console.restore();
    }

    expect(console.errors).toEqual(["Failed to open browser (exit code 1)"]);
  });

  test("returns without waiting for the browser to exit", () => {
    setPlatform("linux");
    const launcher = fakeLauncher();





    expect(openBrowser("https://example.com/device", launcher.spawnFn)).toBeUndefined();




    expect(launcher.seen.options).toEqual({
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: false,
    });
    expect(launcher.seen.unrefs).toBe(1);
  });
});
