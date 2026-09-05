import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFile } from "../atomicWriteFile";
import { getPlansDir } from "../config/paths";

const SLUG_MAX = 60;

export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return slug.length > 0 ? slug : "plan";
}

function uniquePlanPath(dir: string, title: string): string {
  const base = slugFromTitle(title);
  let candidate = join(dir, `${base}.md`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${n}.md`);
    n += 1;
  }
  return candidate;
}

function isInsideDir(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function writePlanFile(
  configDir: string,
  title: string,
  markdown: string,
): { path: string; title: string; markdown: string } {
  const path = uniquePlanPath(getPlansDir(configDir), title);
  const body = markdown.startsWith("#") ? markdown : `# ${title}\n\n${markdown}`;
  atomicWriteFile(path, body.endsWith("\n") ? body : `${body}\n`);
  return { path, title, markdown: body.endsWith("\n") ? body : `${body}\n` };
}

export function unlinkPlanFile(path: string, configDir: string): void {
  if (!isInsideDir(getPlansDir(configDir), path)) return;
  if (existsSync(path)) unlinkSync(path);
}
