import { afterEach, describe, expect, test } from "bun:test";
import { openBrowser } from "../../src/auth/browser";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("openBrowser", () => {
  test("win32 launches via cmd /c start", async () => {
    setPlatform("win32");
    let captured: { executable: string; args: string[] } | undefined;
    const spawnFn = async (executable: string, args: string[]) => {
      captured = { executable, args };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await openBrowser("https://example.com/device", spawnFn);

    expect(captured).toEqual({ executable: "cmd", args: ["/c", "start", "", "https://example.com/device"] });
  });

  test("darwin launches via open", async () => {
    setPlatform("darwin");
    let captured: { executable: string; args: string[] } | undefined;
    const spawnFn = async (executable: string, args: string[]) => {
      captured = { executable, args };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await openBrowser("https://example.com/device", spawnFn);

    expect(captured).toEqual({ executable: "open", args: ["https://example.com/device"] });
  });

  test("other platforms launch via xdg-open", async () => {
    setPlatform("linux");
    let captured: { executable: string; args: string[] } | undefined;
    const spawnFn = async (executable: string, args: string[]) => {
      captured = { executable, args };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await openBrowser("https://example.com/device", spawnFn);

    expect(captured).toEqual({ executable: "xdg-open", args: ["https://example.com/device"] });
  });

  test("swallows a spawn failure instead of throwing", async () => {
    setPlatform("linux");
    const spawnFn = async () => {
      throw new Error("no such command");
    };

    await expect(openBrowser("https://example.com/device", spawnFn)).resolves.toBeUndefined();
  });

  test("reports a non-zero exit code instead of treating it as success", async () => {
    setPlatform("linux");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    const spawnFn = async () => ({ stdout: "", stderr: "no handler for URL type", exitCode: 1 });

    try {
      await expect(openBrowser("https://example.com/device", spawnFn)).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual(["Failed to open browser (exit code 1): no handler for URL type"]);
  });
});
