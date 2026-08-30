import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserLauncher } from "../../src/auth/browser";
import { openBrowser } from "../../src/auth/browser";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

// Captures the launch and holds the listeners instead of firing them, so a test decides whether
// the child ever reports anything at all — including the case where it never does.
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

// The launcher writes to stderr on the failure paths, which are the paths under test here.
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

  // cmd.exe reads a bare `&` as a command separator, and an OAuth authorize URL is mostly
  // ampersands. Measured against the live Supabase authorization server before this was quoted:
  // the browser received only `…/authorize?response_type=code`, cmd tried to RUN the rest
  // ("'client_id' is not recognized as an internal or external command"), and the server answered
  // "client_id: expected string, received undefined, redirect_uri: expected string, received
  // undefined". Verified with a real browser against a local listener: unquoted, every parameter
  // after the first arrived missing; quoted and verbatim, all of them arrived.
  test("win32 keeps a URL whose parameters are joined by & in one argument", () => {
    setPlatform("win32");
    const launcher = fakeLauncher();
    const url =
      "https://api.supabase.com/v1/oauth/authorize?response_type=code&client_id=a&state=b";

    openBrowser(url, launcher.spawnFn);

    // One argument, quoted, with nothing split off at an ampersand.
    expect(launcher.seen.args?.at(-1)).toBe(`"${url}"`);
    expect(launcher.seen.args).toHaveLength(4);
    // Without this the quotes are rewritten by Node's own escaping before cmd.exe ever sees them,
    // and the URL truncates exactly as it did unquoted.
    expect(launcher.seen.options?.windowsVerbatimArguments).toBe(true);
  });

  test("a non-Windows launcher passes the URL as one bare argument", () => {
    setPlatform("darwin");
    const launcher = fakeLauncher();
    const url = "https://api.supabase.com/v1/oauth/authorize?response_type=code&client_id=a";

    openBrowser(url, launcher.spawnFn);

    // No shell is involved, so no quoting is wanted — quoting here would put literal quotes in
    // the URL `open` receives.
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
      // A launcher that never starts reports through 'error' rather than by throwing, and it
      // must not reach the caller: the URL is already printed and the user can follow it.
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

    // The fake never fires 'exit', which is the real case: a browser lives as long as its window
    // does. Going through spawnCollect meant awaiting exactly that — `login` printed the URL,
    // then blocked for the full 120 s timeout before polling for a token, and killed the browser
    // it had just launched on the way out.
    expect(openBrowser("https://example.com/device", launcher.spawnFn)).toBeUndefined();

    // The three things that make "does not wait" true, rather than the absence of a hang, which
    // a synchronous test cannot observe: nothing inherited to hold a pipe open, a process group
    // seri's own signals cannot reach, and no reference keeping the event loop alive.
    expect(launcher.seen.options).toEqual({
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: false,
    });
    expect(launcher.seen.unrefs).toBe(1);
  });
});
