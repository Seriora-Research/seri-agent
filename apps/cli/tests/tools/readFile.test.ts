import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "../../src/capToolResult";
import { getCachedEol } from "../../src/tools/eolCache";
import { readFile } from "../../src/tools/readFile";
import { spawnCollect } from "../../src/tools/spawnCollect";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "seri-readFile-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readFile", () => {
  test("normalizes CRLF line endings to LF", async () => {
    const filePath = join(tmpRoot, "crlf.txt");
    writeFileSync(filePath, "line1\r\nline2\r\n");
    expect(await readFile(filePath)).toBe("line1\nline2\n");
  });

  test("reads an LF file unchanged", async () => {
    const filePath = join(tmpRoot, "lf.txt");
    writeFileSync(filePath, "line1\nline2\n");
    expect(await readFile(filePath)).toBe("line1\nline2\n");
  });

  test("returns a file that lands exactly on 30000 characters whole", async () => {
    const filePath = join(tmpRoot, "cap.txt");
    writeFileSync(filePath, "x".repeat(30_000));
    const result = await readFile(filePath);
    expect(result).toHaveLength(30_000);
    expect(result).not.toContain("characters omitted");
  });

  test("caps an oversized file, keeps both ends, and omits the middle", async () => {
    const filePath = join(tmpRoot, "big.txt");
    writeFileSync(filePath, "A".repeat(100_000) + "B".repeat(100_000));
    const result = await readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result.length).toBeLessThan(30_200);
    expect(result.startsWith("A".repeat(100))).toBe(true);
    expect(result.endsWith("B".repeat(100))).toBe(true);
    expect(result).toContain("characters omitted");
  });

  test("does not strand half a surrogate pair when the cut lands inside one", async () => {
    const filePath = join(tmpRoot, "emoji-head.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}`);
    const result = await readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });

  test("does not strand half a pair at the front of the tail either", async () => {
    const filePath = join(tmpRoot, "emoji-tail.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}y`);
    const result = await readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });

  test("a file well over the window budget matches capToolResult of a full decode", async () => {
    const windowBytes = (MAX_TOOL_RESULT_CHARS / 2) * 3 + 4;
    const n = windowBytes + 50_000;
    const filePath = join(tmpRoot, "windowed.txt");
    const body = `${"A".repeat(n)}${"B".repeat(n)}`;
    writeFileSync(filePath, body);
    const result = await readFile(filePath);
    const expected = capToolResult(readFileSync(filePath, "utf8").replace(/\r\n/g, "\n"));
    expect(result).toBe(expected);
    expect(result).toContain(`[${body.length - MAX_TOOL_RESULT_CHARS} characters omitted]`);
  });

  test("CRLF only in the skipped middle still caches CRLF", async () => {
    const windowBytes = (MAX_TOOL_RESULT_CHARS / 2) * 3 + 4;
    const filePath = join(tmpRoot, "middle-eol.txt");
    const pad = "x".repeat(windowBytes + 100);
    writeFileSync(filePath, `${pad}\r\n${pad}`);
    await readFile(filePath);
    expect(getCachedEol(filePath)).toBe("CRLF");
  });

  test("windowed mixed BMP and emoji does not strand a replacement character", async () => {
    const filePath = join(tmpRoot, "windowed-mix.txt");
    const body = `x${"\u{1F600}".repeat(20_000)}${"中".repeat(20_000)}${"\u{1F600}".repeat(20_000)}y`;
    writeFileSync(filePath, body);
    const result = await readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
    expect(result).toBe(capToolResult(readFileSync(filePath, "utf8").replace(/\r\n/g, "\n")));
  });

  test("attended PNG returns an image read, not utf8 garbage", async () => {
    const filePath = join(tmpRoot, "tiny.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(filePath, png);
    const result = await readFile(filePath, { images: true });
    expect(result).toEqual({
      kind: "image",
      mime: "image/png",
      data: png.toString("base64"),
    });
  });

  test("scheduled PNG returns a refusal string and does not ingest bytes", async () => {
    const filePath = join(tmpRoot, "sched.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(filePath, png);
    expect(await readFile(filePath, { images: false })).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
    expect(await readFile(filePath)).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
  });

  test("an oversized PNG is refused as an image, not decoded as text", async () => {
    const filePath = join(tmpRoot, "huge.png");
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    bytes[0] = 0x89;
    bytes[1] = 0x50;
    bytes[2] = 0x4e;
    bytes[3] = 0x47;
    writeFileSync(filePath, bytes);
    expect(await readFile(filePath, { images: true })).toBe(
      "this image is larger than 4194304 bytes",
    );
    expect(await readFile(filePath, { images: false })).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
  });

  test("an already-aborted signal rejects instead of reading", async () => {
    const filePath = join(tmpRoot, "abort.txt");
    writeFileSync(filePath, "secret\n");
    const controller = new AbortController();
    controller.abort();
    await expect(readFile(filePath, { abortSignal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
  });

  test.skipIf(process.platform === "win32")(
    "sibling FIFO reads complete, which a blocking readFile cannot",
    async () => {
      const a = join(tmpRoot, "a.fifo");
      const b = join(tmpRoot, "b.fifo");
      expect(spawnSync("mkfifo", [a]).status).toBe(0);
      expect(spawnSync("mkfifo", [b]).status).toBe(0);

      const modulePath = pathToFileURL(join(import.meta.dir, "../../src/tools/readFile.ts")).href;
      const script =
        `const m = await import(${JSON.stringify(modulePath)});` +
        `const { writeFile } = await import("node:fs/promises");` +
        `const reads = Promise.all([m.readFile(${JSON.stringify(a)}), m.readFile(${JSON.stringify(b)})]);` +
        `await writeFile(${JSON.stringify(b)}, "beta\\n");` +
        `await writeFile(${JSON.stringify(a)}, "alpha\\n");` +
        `const [ra, rb] = await reads;` +
        `if (ra !== "alpha\\n" || rb !== "beta\\n") { console.error(JSON.stringify({ ra, rb })); process.exit(2); }`;

      const result = await spawnCollect(process.execPath, ["-e", script], 2000);
      expect({
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        stderr: result.stderr,
      }).toEqual({ timedOut: false, exitCode: 0, stderr: "" });
    },
    15000,
  );

  test.skipIf(process.platform === "win32")(
    "an in-flight read does not re-seed the EOL cache after a later write",
    async () => {
      const fifo = join(tmpRoot, "stale.fifo");
      const other = join(tmpRoot, "other.txt");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

      const readMod = pathToFileURL(join(import.meta.dir, "../../src/tools/readFile.ts")).href;
      const writeMod = pathToFileURL(join(import.meta.dir, "../../src/tools/writeFile.ts")).href;
      const eolMod = pathToFileURL(join(import.meta.dir, "../../src/tools/eolCache.ts")).href;
      const script =
        `const m = await import(${JSON.stringify(readMod)});` +
        `const w = await import(${JSON.stringify(writeMod)});` +
        `const e = await import(${JSON.stringify(eolMod)});` +
        `const { writeFile } = await import("node:fs/promises");` +
        `const pending = m.readFile(${JSON.stringify(fifo)});` +
        `w.writeFile(${JSON.stringify(other)}, "new\\n", { eol: "LF" });` +
        `await writeFile(${JSON.stringify(fifo)}, "old\\r\\n");` +
        `const text = await pending;` +
        `if (text !== "old\\n") { console.error(JSON.stringify({ text })); process.exit(2); }` +
        `const cached = e.getCachedEol(${JSON.stringify(fifo)});` +
        `if (cached !== undefined) { console.error(JSON.stringify({ cached })); process.exit(3); }`;

      const result = await spawnCollect(process.execPath, ["-e", script], 2000);
      expect({
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        stderr: result.stderr,
      }).toEqual({ timedOut: false, exitCode: 0, stderr: "" });
    },
    15000,
  );

  test.skipIf(process.platform === "win32")(
    "an in-flight read does not re-seed the EOL cache after a shell-style clear",
    async () => {
      const fifo = join(tmpRoot, "cleared.fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

      const readMod = pathToFileURL(join(import.meta.dir, "../../src/tools/readFile.ts")).href;
      const eolMod = pathToFileURL(join(import.meta.dir, "../../src/tools/eolCache.ts")).href;
      const script =
        `const m = await import(${JSON.stringify(readMod)});` +
        `const e = await import(${JSON.stringify(eolMod)});` +
        `const { writeFile } = await import("node:fs/promises");` +
        `const pending = m.readFile(${JSON.stringify(fifo)});` +
        `e.clearEolCache();` +
        `await writeFile(${JSON.stringify(fifo)}, "old\\r\\n");` +
        `const text = await pending;` +
        `if (text !== "old\\n") { console.error(JSON.stringify({ text })); process.exit(2); }` +
        `const cached = e.getCachedEol(${JSON.stringify(fifo)});` +
        `if (cached !== undefined) { console.error(JSON.stringify({ cached })); process.exit(3); }`;

      const result = await spawnCollect(process.execPath, ["-e", script], 2000);
      expect({
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        stderr: result.stderr,
      }).toEqual({ timedOut: false, exitCode: 0, stderr: "" });
    },
    15000,
  );
});
