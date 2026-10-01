import { describe, expect, test } from "bun:test";
import {
  encodeBlobJson,
  encodeMessageJson,
  encodeRecapJson,
  redactText,
  withheldToolCallIds,
} from "../../src/session/redact";

const GHP = `ghp_${"A".repeat(20)}B9Qx`;
const SK = "sk-abcdefghijklmnopqrstuvwxyz012345";
const ENV_CMD = `GITHUB_TOKEN=${GHP} yarn install`;

describe("redactText", () => {
  test("replaces a ghp_ token with a typed marker that keeps a short tail", () => {
    const out = redactText(`token ${GHP} done`);
    expect(out.text).toBe("token [redacted:github-pat:B9Qx] done");
    expect(out.found).toEqual({ "github-pat": 1 });
    expect(out.text).not.toContain(GHP);
  });

  test("replaces an sk- shaped key and a second pass is a no-op", () => {
    const first = redactText(`key ${SK}`);
    expect(first.text).toBe("key [redacted:sk-key:2345]");
    expect(first.found).toEqual({ "sk-key": 1 });
    const second = redactText(first.text);
    expect(second).toEqual({ text: first.text, found: {} });
  });

  test("keeps the assignment name and uses the token kind when they overlap", () => {
    const out = redactText(ENV_CMD);
    expect(out.text).toBe("GITHUB_TOKEN=[redacted:github-pat:B9Qx] yarn install");
    expect(out.found).toEqual({ "github-pat": 1 });
    expect(out.text).not.toContain(GHP);
  });

  test("does not flag a short sk- stub or a PATH= assignment", () => {
    expect(redactText("sk-short PATH=/usr/bin TOKEN=$FOO")).toEqual({
      text: "sk-short PATH=/usr/bin TOKEN=$FOO",
      found: {},
    });
  });

  test("replaces a Bearer token and a PEM block without a tail", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
    expect(redactText(`Authorization: Bearer ${"a".repeat(20)}1`).text).toBe(
      "Authorization: Bearer [redacted:bearer]",
    );
    expect(redactText(pem)).toEqual({
      text: "[redacted:private-key]",
      found: { "private-key": 1 },
    });
  });
});

describe("encodeMessageJson", () => {
  test("a live bash result keeps the raw token in memory and writes a marker", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "printenv" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "json", value: { stdout: GHP, exitCode: 0 } },
          },
        ],
      },
    ];
    const withheld = withheldToolCallIds(messages);
    expect([...withheld]).toEqual([]);
    const encoded = encodeMessageJson(messages[1], withheld);
    expect(encoded.json).toContain("[redacted:github-pat:B9Qx]");
    expect(encoded.json).not.toContain(GHP);
    const liveStdout = (
      messages[1] as {
        content: Array<{ output: { value: { stdout: string } } }>;
      }
    ).content[0]?.output.value.stdout;
    expect(liveStdout).toBe(GHP);
  });

  test("a denied tool-call is withheld even when the secret does not match a pattern", () => {
    const odd = "not-a-known-shape-secret-value";
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "bash",
            input: { command: `SOME_TOKEN=${odd} yarn install` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "bash",
            output: { type: "execution-denied", reason: "blocked" },
          },
        ],
      },
    ];
    const withheld = withheldToolCallIds(messages);
    expect([...withheld]).toEqual(["c2"]);
    const encoded = encodeMessageJson(messages[0], withheld);
    expect(JSON.parse(encoded.json)).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "bash",
          input: { command: "[redacted:withheld]" },
        },
      ],
    });
    expect(encoded.json).not.toContain(odd);
  });

  test("a completed result without toolCallId is pattern-redacted, not withheld", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", output: { type: "text", value: "ok" } }] },
    ];
    expect([...withheldToolCallIds(messages)]).toEqual([]);
    const encoded = encodeMessageJson(messages[0], withheldToolCallIds(messages));
    expect(encoded.json).toContain('"command":"pwd"');
    expect(encoded.json).not.toContain("[redacted:withheld]");
  });

  test("a sibling without a matching result stays withheld while its peer has one", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "done",
            toolName: "bash",
            input: { command: "pwd" },
          },
          {
            type: "tool-call",
            toolCallId: "pending",
            toolName: "bash",
            input: { command: ENV_CMD },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "done",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    expect([...withheldToolCallIds(messages)]).toEqual(["pending"]);
    const encoded = encodeMessageJson(messages[0], withheldToolCallIds(messages));
    expect(encoded.json).toContain('"command":"pwd"');
    expect(encoded.json).toContain("[redacted:withheld]");
    expect(encoded.json).not.toContain(GHP);
  });

  test("once a matching result arrives, the call is pattern-redacted instead of withheld", () => {
    const pending = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: ENV_CMD },
          },
        ],
      },
    ];
    expect(encodeMessageJson(pending[0], withheldToolCallIds(pending)).json).toContain(
      "[redacted:withheld]",
    );
    const done = [
      ...pending,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "ok" } },
          },
        ],
      },
    ];
    const encoded = encodeMessageJson(done[0], withheldToolCallIds(done));
    expect(encoded.json).toContain("[redacted:github-pat:B9Qx]");
    expect(encoded.json).not.toContain("[redacted:withheld]");
    expect(encoded.json).not.toContain(GHP);
  });

  test("a pending tool-call with no result yet is withheld on the first persist", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c3",
            toolName: "bash",
            input: { command: ENV_CMD },
          },
        ],
      },
    ];
    const encoded = encodeMessageJson(messages[0], withheldToolCallIds(messages));
    expect(encoded.json).toContain("[redacted:withheld]");
    expect(encoded.json).not.toContain(GHP);
  });

  test("user text is not rewritten", () => {
    const encoded = encodeMessageJson(
      { role: "user", content: [{ type: "text", text: GHP }] },
      new Set(),
    );
    expect(encoded.json).toContain(GHP);
    expect(encoded.found).toEqual({});
  });
});

describe("encodeBlobJson", () => {
  test("an approval-request withholds args", () => {
    const encoded = encodeBlobJson({
      v: 1,
      event: {
        type: "approval-request",
        requestId: "r1",
        toolName: "bash",
        args: { command: ENV_CMD },
      },
    });
    expect(encoded.json).toContain("[redacted:withheld]");
    expect(encoded.json).not.toContain(GHP);
  });

  test("an allowed tool-call event is pattern-redacted", () => {
    const encoded = encodeBlobJson({ type: "tool-call", name: "bash", args: { command: ENV_CMD } });
    expect(encoded.json).toContain("[redacted:github-pat:B9Qx]");
    expect(encoded.json).not.toContain(GHP);
  });
});

describe("encodeRecapJson", () => {
  test("pattern-redacts strings in a compact recap", () => {
    const encoded = encodeRecapJson({
      role: "user",
      content: [{ type: "text", text: `used ${SK}` }],
    });
    expect(encoded.json).toContain("[redacted:sk-key:2345]");
    expect(encoded.json).not.toContain(SK);
  });
});
