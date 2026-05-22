import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptArgs = Record<string, string | number>;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export function renderPrompt(name: string, args: PromptArgs): string {
  const path = join(PROMPTS_DIR, `${name}.md`);
  const template = readFileSync(path, "utf-8");

  const referenced = new Set<string>();
  const result = template.replace(PLACEHOLDER, (_m, key: string) => {
    referenced.add(key);
    if (!(key in args)) {
      throw new Error(
        `Prompt template "${name}" references {{${key}}} but no value was provided`,
      );
    }
    return String(args[key]);
  });

  for (const key of Object.keys(args)) {
    if (!referenced.has(key)) {
      throw new Error(
        `Prompt template "${name}" was given arg "${key}" but does not reference it`,
      );
    }
  }

  return result;
}
