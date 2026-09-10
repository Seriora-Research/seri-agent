import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  test("normalizes CRLF line endings to LF", () => {
    const filePath = join(tmpRoot, "crlf.txt");
    writeFileSync(filePath, "line1\r\nline2\r\n");
    expect(readFile(filePath)).toBe("line1\nline2\n");
  });

  test("reads an LF file unchanged", () => {
    const filePath = join(tmpRoot, "lf.txt");
    writeFileSync(filePath, "line1\nline2\n");
    expect(readFile(filePath)).toBe("line1\nline2\n");
  });

  test("returns a file that lands exactly on 30000 characters whole", () => {
    const filePath = join(tmpRoot, "cap.txt");
    writeFileSync(filePath, "x".repeat(30_000));
    const result = readFile(filePath);
    expect(result).toHaveLength(30_000);
    expect(result).not.toContain("characters omitted");
  });

  test("caps an oversized file, keeps both ends, and omits the middle", () => {
    const filePath = join(tmpRoot, "big.txt");
    writeFileSync(filePath, "A".repeat(100_000) + "B".repeat(100_000));
    const result = readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result.length).toBeLessThan(30_200);
    expect(result.startsWith("A".repeat(100))).toBe(true);
    expect(result.endsWith("B".repeat(100))).toBe(true);
    expect(result).toContain("characters omitted");
  });

  test("does not strand half a surrogate pair when the cut lands inside one", () => {
    const filePath = join(tmpRoot, "emoji-head.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}`);
    const result = readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });

  test("does not strand half a pair at the front of the tail either", () => {
    const filePath = join(tmpRoot, "emoji-tail.txt");
    writeFileSync(filePath, `x${"\u{1F600}".repeat(20_000)}y`);
    const result = readFile(filePath);
    if (typeof result !== "string") throw new Error("expected text");
    expect(result).toContain("characters omitted");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    expect(result).not.toContain("�");
  });

  test("attended PNG returns an image read, not utf8 garbage", () => {
    const filePath = join(tmpRoot, "tiny.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(filePath, png);
    const result = readFile(filePath, { images: true });
    expect(result).toEqual({
      kind: "image",
      mime: "image/png",
      data: png.toString("base64"),
    });
  });

  test("scheduled PNG returns a refusal string and does not ingest bytes", () => {
    const filePath = join(tmpRoot, "sched.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(filePath, png);
    expect(readFile(filePath, { images: false })).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
    expect(readFile(filePath)).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
  });

  test("an oversized PNG is refused as an image, not decoded as text", () => {
    const filePath = join(tmpRoot, "huge.png");
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    bytes[0] = 0x89;
    bytes[1] = 0x50;
    bytes[2] = 0x4e;
    bytes[3] = 0x47;
    writeFileSync(filePath, bytes);
    expect(readFile(filePath, { images: true })).toBe("this image is larger than 4194304 bytes");
    expect(readFile(filePath, { images: false })).toBe(
      "this file is an image; scheduled runs do not ingest screenshots",
    );
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
        `await Promise.all([writeFile(${JSON.stringify(a)}, "alpha\\n"), writeFile(${JSON.stringify(b)}, "beta\\n")]);` +
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
});
