import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";

// bun compile embeds a literal local file, not @vscode/ripgrep's dynamic require.resolve.
const dest = fileURLToPath(new URL("./rg-vendored.bin", import.meta.url));
copyFileSync(rgPath, dest);
