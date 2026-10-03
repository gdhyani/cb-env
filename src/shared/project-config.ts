import fs from "node:fs";
import path from "node:path";
import { MSG, PROJECT_DIR, PROJECT_FILE } from "../constants";
import { CbError } from "./errors";
import { writeJsonAtomic } from "./files";
import { type ProjectConfig, ProjectConfigSchema } from "./schemas";

/** Walks up from cwd to the nearest `.cb/project.json`. */
export function findProjectConfig(
  cwd = process.cwd(),
): { file: string; root: string; config: ProjectConfig } | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, PROJECT_DIR, PROJECT_FILE);
    if (fs.existsSync(file)) {
      return { file, root: dir, config: ProjectConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireProjectConfig(cwd = process.cwd()) {
  const found = findProjectConfig(cwd);
  if (!found) throw new CbError("NOT_INITIALISED", MSG.notInitialised);
  return found;
}

export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<string> {
  const file = path.join(root, PROJECT_DIR, PROJECT_FILE);
  await writeJsonAtomic(file, ProjectConfigSchema.parse(config), 0o644);
  return file;
}
