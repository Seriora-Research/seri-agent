import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";

// Copies the current machine's platform-specific rg binary (resolved by @vscode/ripgrep's
// own dynamic require.resolve, which works fine here since node_modules is really on disk)
// to a local, statically-importable file. runRipgrep.ts embeds *that* into the compiled
// binary via `with { type: "file" }` — a literal specifier bun can resolve and embed at
// build time, unlike a cross-platform template import that only some machines can satisfy.
const dest = fileURLToPath(new URL("./rg-vendored.bin", import.meta.url));
copyFileSync(rgPath, dest);
