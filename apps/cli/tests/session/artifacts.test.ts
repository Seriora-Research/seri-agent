import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toImageRead, toolOutputForImage, userContentFrom } from "../../src/imageParts";
import {
  hydrateBinaryArtifacts,
  isArtifactRef,
  persistBinaryArtifacts,
} from "../../src/session/artifacts";
import { exportSessionsToJsonl } from "../../src/session/export";
import { loadSession, type SessionState, saveSession } from "../../src/session/session";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PREFIX = "iVBORw0KGgo";

let configDir: string;
let sessionsDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "seri-artifacts-test-"));
  sessionsDir = join(configDir, "sessions");
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function pngBytes(size: number, fill: number): Buffer {
  const bytes = Buffer.alloc(size, fill);
  PNG_MAGIC.copy(bytes);
  return bytes;
}

function fileMessage(label: string, bytes: Buffer) {
  return {
    role: "user" as const,
    content: userContentFrom(label, [{ mime: "image/png", bytes }]),
  };
}

function toolImageMessage(bytes: Buffer) {
  return {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "c1",
        toolName: "read_file",
        output: toolOutputForImage(toImageRead({ mime: "image/png", bytes })),
      },
    ],
  };
}

function sessionWith(id: string, messages: unknown[]): SessionState {
  return {
    id,
    cwd: "/repo",
    systemPrompt: "system",
    permissionMode: "approve-each",
    messages,
  };
}

function storedJson(id: string): string[] {
  const raw = new Database(join(configDir, "seri.db"));
  try {
    return (
      raw.query("SELECT json FROM messages WHERE session_id = ? ORDER BY seq").all(id) as {
        json: string;
      }[]
    ).map((row) => row.json);
  } finally {
    raw.close();
  }
}

describe("persistBinaryArtifacts", () => {
  test("replaces inline file parts with refs and writes the bytes once", () => {
    const a = pngBytes(40_000, 0x11);
    const b = pngBytes(40_000, 0x12);
    const messages = [fileMessage("one", a), fileMessage("two", b), fileMessage("one-again", a)];
    const stored = persistBinaryArtifacts(messages, configDir, "sess");

    expect(JSON.stringify(messages)).toContain(PNG_PREFIX);
    expect(JSON.stringify(stored)).not.toContain(PNG_PREFIX);
    const refs = stored.flatMap((message) => {
      const content = (message as { content: Array<{ data: unknown }> }).content;
      return content.filter((part) => isArtifactRef(part.data)).map((part) => part.data);
    });
    expect(refs).toHaveLength(3);
    expect(refs[0]).toEqual(refs[2]);
    expect(refs[0]).not.toEqual(refs[1]);

    const files = readdirSync(join(configDir, "artifacts", "sess"));
    expect(files).toHaveLength(2);
    for (const name of files) {
      expect(readFileSync(join(configDir, "artifacts", "sess", name)).byteLength).toBe(40_000);
    }
  });

  test("keeps the inline payload when the artifact write cannot succeed", () => {
    mkdirSync(join(configDir, "artifacts"));
    writeFileSync(join(configDir, "artifacts", "blocked"), "not a directory");
    const bytes = pngBytes(8_000, 0x33);
    const messages = [fileMessage("blocked", bytes)];
    const stored = persistBinaryArtifacts(messages, configDir, "blocked");
    expect(JSON.stringify(stored)).toContain(PNG_PREFIX);
    expect(stored).toEqual(messages);
  });

  test("hydrate restores file parts and ImageRead payloads from refs", () => {
    const png = pngBytes(12_000, 0x44);
    const messages = [
      fileMessage("shot", png),
      {
        role: "tool",
        content: [{ type: "tool-result", result: toImageRead({ mime: "image/png", bytes: png }) }],
      },
    ];
    const stored = persistBinaryArtifacts(messages, configDir, "round");
    expect(JSON.stringify(stored)).not.toContain(PNG_PREFIX);
    const hydrated = hydrateBinaryArtifacts(stored, configDir, "round");
    expect(hydrated).toEqual(messages);
  });
});

describe("session save/load and JSONL export", () => {
  test("several large images stay metadata-sized on disk and resume from refs", () => {
    const first = pngBytes(60_000, 1);
    const second = pngBytes(70_000, 2);
    const third = pngBytes(80_000, 3);
    const messages = [fileMessage("a", first), toolImageMessage(second), fileMessage("c", third)];
    const state = sessionWith("pix", messages);
    const liveBefore = JSON.stringify(state.messages);
    saveSession(state, sessionsDir);

    expect(JSON.stringify(state.messages)).toBe(liveBefore);
    expect(loadSession("pix", sessionsDir).messages).toEqual(messages);

    const json = storedJson("pix").join("\n");
    expect(json).not.toContain(PNG_PREFIX);
    expect(Buffer.byteLength(json)).toBeLessThan(4_000);
    expect(Buffer.byteLength(liveBefore)).toBeGreaterThan(200_000);

    const exported = exportSessionsToJsonl(configDir, join(configDir, "out"));
    expect(exported).toHaveLength(1);
    const exportPath = exported[0];
    if (exportPath === undefined) throw new Error("expected an exported jsonl path");
    const jsonl = readFileSync(exportPath, "utf8");
    expect(jsonl).not.toContain(PNG_PREFIX);
    expect(jsonl).toContain('"type":"artifact"');
    expect(existsSync(join(configDir, "artifacts", "pix"))).toBe(true);
  });

  test("a failed artifact write leaves the stored transcript inline", () => {
    mkdirSync(join(configDir, "artifacts"));
    writeFileSync(join(configDir, "artifacts", "pix"), "not a directory");
    const messages = [fileMessage("still inline", pngBytes(9_000, 5))];
    saveSession(sessionWith("pix", messages), sessionsDir);
    expect(storedJson("pix").join("\n")).toContain(PNG_PREFIX);
    expect(loadSession("pix", sessionsDir).messages).toEqual(messages);
  });

  test("binary payloads persist as artifact refs while tool-channel secrets redact", () => {
    const png = pngBytes(12_000, 0x11);
    const ghp = `ghp_${"A".repeat(20)}B9Qx`;
    const sk = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const messages = [
      fileMessage("shot", png),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: `echo ${ghp}` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "json", value: { stdout: `${ghp}\n${sk}`, exitCode: 0 } },
          },
        ],
      },
      toolImageMessage(png),
    ];
    const state = sessionWith("both", messages);
    const liveBefore = JSON.stringify(state.messages);
    saveSession(state, sessionsDir);

    expect(JSON.stringify(state.messages)).toBe(liveBefore);
    expect(liveBefore).toContain(ghp);
    expect(liveBefore).toContain(sk);
    expect(liveBefore).toContain(PNG_PREFIX);

    const json = storedJson("both").join("\n");
    expect(json).toContain('"type":"artifact"');
    expect(json).not.toContain(PNG_PREFIX);
    expect(json).toContain("[redacted:github-pat:B9Qx]");
    expect(json).toContain("[redacted:sk-key:2345]");
    expect(json).not.toContain(ghp);
    expect(json).not.toContain(sk);

    const loadedJson = JSON.stringify(loadSession("both", sessionsDir).messages);
    expect(loadedJson).toContain(PNG_PREFIX);
    expect(loadedJson).toContain("[redacted:github-pat:B9Qx]");
    expect(loadedJson).not.toContain(ghp);

    const exported = exportSessionsToJsonl(configDir, join(configDir, "out-both"));
    expect(exported).toHaveLength(1);
    const exportPath = exported[0];
    if (exportPath === undefined) throw new Error("expected an exported jsonl path");
    const jsonl = readFileSync(exportPath, "utf8");
    expect(jsonl).toContain('"type":"artifact"');
    expect(jsonl).not.toContain(PNG_PREFIX);
    expect(jsonl).not.toContain(ghp);
    expect(jsonl).toContain("[redacted:github-pat:B9Qx]");
  });
});
