// Answers one question `@opentui/core`'s source cannot: does its native host clipboard reach the
// real OS clipboard on THIS machine. Run it on each platform the spec needs a row for.
//
//   bun .claude/skills/verify-seri/scripts/probe-clipboard.mjs [sentinel]
//
// bun, not node: seri ships as a bun binary and the clipboard is an FFI call into opentui's
// native library, so the bun entrypoint is the one that matters. The write lands in the user's
// real clipboard, so the prior contents are read first and put back before exit.
//
// Prints the write status, what read back, and whether the round trip matched. Confirm it
// independently afterwards with the platform's own reader (`Get-Clipboard` on Windows,
// `pbpaste` on macOS, `wl-paste` or `xclip -o` on Linux) — this script reads through the same
// library it wrote with, which on its own would not prove the OS clipboard was ever touched.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// @opentui/core is a dependency of apps/cli, not of the repo root, and this script sits under
// .claude — neither is a directory bun would resolve it from, so it is resolved explicitly the
// way drive-tui.mjs resolves node-pty.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(join(ROOT, "apps/cli/package.json"));
const { createHostClipboard } = await import(pathToFileURL(require.resolve("@opentui/core")).href);

const sentinel = process.argv[2] ?? `SERI-CLIP-PROBE-${Date.now()}`;
const clipboard = createHostClipboard();

const readText = async () => {
  const result = await clipboard.read({ preferredTypes: ["text/plain"] });
  return result.status === "read" ? new TextDecoder().decode(result.representation.bytes) : null;
};

const previous = await readText();
const write = await clipboard.writeText(sentinel);
const readBack = await readText();

console.log(`platform:      ${process.platform}`);
console.log(`maxWriteBytes: ${clipboard.maxWriteBytes}`);
console.log(`write:         ${JSON.stringify(write)}`);
console.log(`read back:     ${JSON.stringify(readBack)}`);
console.log(`round trip:    ${readBack === sentinel ? "MATCH" : "MISMATCH"}`);

if (previous !== null) await clipboard.writeText(previous);
await clipboard.dispose();
