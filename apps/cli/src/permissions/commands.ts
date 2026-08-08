import { existsSync } from "node:fs";
import { effectiveTools, forgetGrant, loadGrants, PERSISTABLE_TOOLS, permissionsPath } from "./store";

const USAGE = `Usage:
  seri permissions list
  seri permissions remove <tool>`;

function listCommand(configDir: string, worktree: string): number {
  const path = permissionsPath(configDir);
  // Not `printWarning` from cli/output.ts: that import would cross the module boundary the plan
  // draws around this file (permissions/store.ts is the only module cli.ts's printer wiring
  // touches). Same "⚠ " format, kept local instead of shared — loadGrants degrading a malformed
  // or unreadable file to empty (HIGH-1) must not be silent here, or `list` would affirmatively
  // claim nothing is stored when something is, just unreadable.
  const grants = loadGrants(configDir, worktree, (m) => console.error(`⚠ ${m}`));

  if (effectiveTools(grants).length === 0 && grants.otherProjects === 0) {
    if (existsSync(path)) {
      // A file is there but loadGrants came back empty anyway — the degrade path for an
      // unreadable or malformed store, not an absent one. "Nothing is stored" would be false:
      // something is stored, it just could not be read. The warning above named what went wrong.
      console.log(`The permissions store at ${path} could not be read — see the warning above.`);
    } else {
      console.log("No tools are permanently approved.");
      console.log(`(nothing is stored at ${path})`);
    }
    return 0;
  }

  console.log(`Permanently approved tools — ${path}`);
  console.log("");
  if (grants.global.length > 0) {
    console.log("  every project:");
    for (const tool of grants.global) console.log(`    ${tool}`);
    console.log("");
  }
  if (grants.project.length > 0) {
    console.log(`  this project (${worktree}):`);
    for (const tool of grants.project) console.log(`    ${tool}`);
    console.log("");
  }
  // The count is not padding: without it a grant in a project the user is not standing in is one
  // they cannot see, which is the exact failure this section exists to close.
  if (grants.otherProjects > 0) console.log(`Grants for ${grants.otherProjects} other project(s) are in the file.`);
  console.log("Revoke with: seri permissions remove <tool>");
  return 0;
}

// bash/powershell can never be in the file (the read filter drops them), so this is reported
// distinctly from "not approved" rather than as a false positive for a hand-edit that was ignored.
function removeCommand(configDir: string, worktree: string, tool: string): number {
  if (!PERSISTABLE_TOOLS.has(tool)) {
    console.log(`${tool} was not permanently approved — bash and powershell never can be.`);
    return 0;
  }

  // Same reason listCommand passes one: forgetGrant degrading a malformed/unreadable store to
  // "nothing removed" must not be silent, or `remove` would print the same false "was not
  // permanently approved" a genuinely-empty store gets.
  const result = forgetGrant(configDir, worktree, tool, (m) => console.error(`⚠ ${m}`));
  // Both sections are reported when both held it: the user's intent typing "remove <tool>" is "stop
  // auto-approving <tool>", and a command that printed "Removed" while a global entry survived would
  // contradict the very next run.
  if (result.global && result.project) {
    console.log(`Removed ${tool} from the global list and from this project (${worktree}).`);
  } else if (result.project) {
    console.log(`Removed ${tool} from this project (${worktree}).`);
  } else if (result.global) {
    console.log(`Removed ${tool} from the global list.`);
  } else {
    console.log(`${tool} was not permanently approved.`);
  }
  return 0;
}

// `worktree` is passed in rather than resolved here so this stays testable with a plain path and
// spawns no git of its own — the same reason checkpointTarget resolves the root at one place in
// cli.ts instead of at each call site.
export function permissionsCommand(args: string[], configDir: string, worktree: string): number {
  const [subcommand, tool] = args;

  if (subcommand === "list") return listCommand(configDir, worktree);

  if (subcommand === "remove") {
    if (!tool) {
      console.error(USAGE);
      return 2;
    }
    return removeCommand(configDir, worktree, tool);
  }

  console.error(USAGE);
  return 2;
}
