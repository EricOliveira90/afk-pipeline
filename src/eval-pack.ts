/**
 * The scenario-pack reader for `afk eval` (`prd.md` D7, D8, D12, D13).
 *
 * A pack is a directory of `*.json` case files — no index file, no config
 * key — and **declared order is the byte-wise ascending order of case file
 * names**, so an author controls it by prefixing `01-`, `02-`. Two things to
 * keep in sync became one.
 *
 * Every defect refuses the **whole pack** naming the file and the member.
 * Skipping the defective case would spend model calls on a pack whose author
 * has already been shown to be wrong about its schema, and a run whose case
 * list depends on which files happened to parse is not the reproducible
 * measurement the harness exists to produce.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Bump when a version-1 pack could be read differently than it is today —
 * a member gaining a meaning, a value set narrowing, an order rule changing.
 * Adding an optional member that an existing pack cannot carry is not such a
 * change, but this reader has no optional members: the seven are exact.
 */
export const EVAL_PACK_VERSION = 1;

/** Every pack version a reader in this process accepts. */
export const SUPPORTED_EVAL_PACK_VERSIONS = [1] as const;

export type EvalPackVersion = (typeof SUPPORTED_EVAL_PACK_VERSIONS)[number];

/**
 * The roles whose output is a verdict a case can state an expectation about
 * (D12). `explorer` and `generator` are deliberately absent — their output is
 * a document and code, measured by the suites, not by a projection.
 */
export const EVAL_ROLES = [
  "evaluator-contract",
  "evaluator-qa",
  "evaluator-final",
  "planner",
  "pm",
  "architect",
] as const;

export type EvalRole = (typeof EVAL_ROLES)[number];

/** An inline UTF-8 body, or a byte-for-byte copy of a file beside the pack. */
export type EvalFileContent = string | { fromFile: string };

/**
 * The projection of a role's verdict, and therefore the whole of what a case
 * may expect (D9). No findings, no ids, no prose, no tree ids: nothing here is
 * a collection, so comparison is field-by-field string equality.
 */
export type EvalExpected =
  | { verdict: "ACCEPT" | "REVISE" }
  | { verdict: "PASS" | "FAIL"; failureClass: "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE" }
  | { verdict: "PASS" | "FAIL" }
  | { artifact: "CONTRACT" | "ESCALATION" }
  | { outcome: "SHIP" | "ACCEPT-WITH-NOTES" | "FIX-BEFORE-SHIP" | "UNPARSEABLE" };

export interface EvalCase {
  version: 1;
  /** Names a scratch directory and a log file, so it is a slug and unique. */
  id: string;
  role: EvalRole;
  /** Non-blank provenance: the issue, run or artifact this case came from. */
  source: string;
  /** The envelope — the exact `InvokeOptions.prompt` the role receives. */
  prompt: string;
  /** Seeded into the case's fresh scratch directory. May be empty. */
  files: Record<string, EvalFileContent>;
  expected: EvalExpected;
}

export interface EvalPack {
  version: 1;
  /** Absolute path of the pack directory; `fromFile` resolves against it. */
  dir: string;
  cases: EvalCase[];
}

/** The seven members a case file carries — exactly these, in this order. */
const CASE_KEYS = [
  "version",
  "id",
  "role",
  "source",
  "prompt",
  "files",
  "expected",
] as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The D9 table's right-hand column as data: for each role, every key its
 * `expected` must carry and every value that key may hold. `expected` is
 * validated against the case's `role` at read time, so a value the role's
 * parser could never produce is refused before a model call is spent.
 */
const EXPECTED_SHAPE: Readonly<
  Record<EvalRole, Readonly<Record<string, readonly string[]>>>
> = {
  "evaluator-contract": { verdict: ["ACCEPT", "REVISE"] },
  "evaluator-qa": {
    verdict: ["PASS", "FAIL"],
    failureClass: ["NONE", "IMPLEMENTATION", "INFRASTRUCTURE"],
  },
  "evaluator-final": { verdict: ["PASS", "FAIL"] },
  planner: { artifact: ["CONTRACT", "ESCALATION"] },
  pm: {
    outcome: ["SHIP", "ACCEPT-WITH-NOTES", "FIX-BEFORE-SHIP", "UNPARSEABLE"],
  },
  architect: {
    outcome: ["SHIP", "ACCEPT-WITH-NOTES", "FIX-BEFORE-SHIP", "UNPARSEABLE"],
  },
};

/**
 * Every `files` key and every `fromFile` target is a relative POSIX path
 * inside the pack: no drive letter, no leading `/` or `./`, no `..` segment,
 * no backslash. Returns the defect, or `null` when the path is admissible.
 */
function pathDefect(value: string): string | null {
  if (value === "") return "must not be empty";
  if (value.includes("\\")) {
    return 'must use forward slashes, not "\\"';
  }
  if (/^[A-Za-z]:/.test(value)) return "must not carry a drive letter";
  if (value.startsWith("/")) return 'must not start with "/"';
  if (value.startsWith("./")) return 'must not start with "./"';
  if (value.split("/").includes("..")) return 'must not contain a ".." segment';
  if (value.endsWith("/")) return "must name a file, not a directory";
  return null;
}

function requireNonBlank(
  value: unknown,
  member: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${member} must be a non-blank string`);
  }
  return value;
}

function validateFiles(value: unknown, source: string): Record<string, EvalFileContent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} files must be an object`);
  }
  const files: Record<string, EvalFileContent> = {};
  for (const [key, content] of Object.entries(value)) {
    const defect = pathDefect(key);
    if (defect !== null) {
      throw new Error(`${source} files key "${key}" ${defect}`);
    }
    if (typeof content === "string") {
      files[key] = content;
      continue;
    }
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      throw new Error(
        `${source} files key "${key}" must hold an inline string or { "fromFile": … }`,
      );
    }
    const keys = Object.keys(content);
    if (keys.length !== 1 || keys[0] !== "fromFile") {
      throw new Error(
        `${source} files key "${key}" must hold exactly the member fromFile`,
      );
    }
    const fromFile = (content as { fromFile: unknown }).fromFile;
    if (typeof fromFile !== "string" || fromFile.trim() === "") {
      throw new Error(
        `${source} files key "${key}" fromFile must be a non-blank string`,
      );
    }
    const targetDefect = pathDefect(fromFile);
    if (targetDefect !== null) {
      throw new Error(
        `${source} files key "${key}" fromFile "${fromFile}" ${targetDefect}`,
      );
    }
    files[key] = { fromFile };
  }
  return files;
}

function validateExpected(
  value: unknown,
  role: EvalRole,
  source: string,
): EvalExpected {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} expected must be an object`);
  }
  const shape = EXPECTED_SHAPE[role];
  const expected = value as Record<string, unknown>;
  for (const key of Object.keys(expected)) {
    if (!(key in shape)) {
      throw new Error(
        `${source} expected declares the key "${key}", which role ${role} never projects (${Object.keys(shape).join(", ")})`,
      );
    }
  }
  for (const [key, admitted] of Object.entries(shape)) {
    if (!(key in expected)) {
      throw new Error(
        `${source} expected is missing the key "${key}" that role ${role} projects`,
      );
    }
    const held = expected[key];
    if (typeof held !== "string" || !admitted.includes(held)) {
      throw new Error(
        `${source} expected key "${key}" must be ${admitted.join(" or ")} for role ${role}, not ${JSON.stringify(held)}`,
      );
    }
  }
  return expected as EvalExpected;
}

/**
 * Validate one parsed case document, or throw naming `source` (the case file
 * name) and the offending member. Pure: nothing here reads the disk, so the
 * refusal rules are assertable without a pack on disk. `fromFile` targets are
 * checked for existence by {@link readEvalPack}, which knows the directory.
 */
export function validateEvalCase(value: unknown, source: string): EvalCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(CASE_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${source} declares the unknown top-level member "${key}"; a case carries exactly ${CASE_KEYS.join(", ")}`,
      );
    }
  }
  for (const key of CASE_KEYS) {
    if (!(key in input)) {
      throw new Error(
        `${source} is missing the top-level member "${key}"; a case carries exactly ${CASE_KEYS.join(", ")}`,
      );
    }
  }

  if (
    typeof input.version !== "number" ||
    !(SUPPORTED_EVAL_PACK_VERSIONS as readonly number[]).includes(input.version)
  ) {
    throw new Error(
      `${source} version ${JSON.stringify(input.version)} is not a supported eval pack version (${SUPPORTED_EVAL_PACK_VERSIONS.join(", ")})`,
    );
  }

  const id = requireNonBlank(input.id, "id", source);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${source} id "${id}" must match ${ID_PATTERN.source}`);
  }

  if (
    typeof input.role !== "string" ||
    !(EVAL_ROLES as readonly string[]).includes(input.role)
  ) {
    throw new Error(
      `${source} role ${JSON.stringify(input.role)} is not an eval role (${EVAL_ROLES.join(", ")})`,
    );
  }
  const role = input.role as EvalRole;

  return {
    version: 1,
    id,
    role,
    source: requireNonBlank(input.source, "source", source),
    prompt: requireNonBlank(input.prompt, "prompt", source),
    files: validateFiles(input.files, source),
    expected: validateExpected(input.expected, role, source),
  };
}

/** Byte-wise ascending, which is what "declared order" means (D8). */
function byBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf-8"), Buffer.from(right, "utf-8"));
}

/**
 * Read a pack directory, or throw naming the file and the member that refused
 * it. Only files **directly inside** `dir` are cases: a subdirectory is where
 * `fromFile` fixtures live, and promoting one to a case would make the case
 * list depend on a traversal order no author declared.
 */
export function readEvalPack(dir: string): EvalPack {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `${dir} is not a readable eval pack directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(byBytes);
  if (names.length === 0) {
    // A pack with nothing to run is a mistake, not a COMPLETE run.
    throw new Error(`${dir} holds no *.json eval case files`);
  }

  const documents = names.map((name) => {
    const text = readFileSync(join(dir, name), "utf-8");
    try {
      return { name, value: JSON.parse(text) as unknown };
    } catch (error) {
      throw new Error(
        `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // Checked across files before any single file is validated, so a pack whose
  // files disagree says so rather than reporting whichever version happens to
  // be unsupported — the two are different author mistakes.
  const declared = new Map<unknown, string>();
  for (const { name, value } of documents) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const version = (value as Record<string, unknown>).version;
    if (version === undefined) continue;
    if (!declared.has(version)) declared.set(version, name);
  }
  if (declared.size > 1) {
    const [[firstVersion, firstFile], [secondVersion, secondFile]] = [
      ...declared.entries(),
    ] as [[unknown, string], [unknown, string]];
    throw new Error(
      `${firstFile} declares version ${JSON.stringify(firstVersion)} but ${secondFile} declares version ${JSON.stringify(secondVersion)}; every case file in a pack must declare the same version`,
    );
  }

  const cases: EvalCase[] = [];
  const idFiles = new Map<string, string>();
  for (const { name, value } of documents) {
    const parsed = validateEvalCase(value, name);
    const owner = idFiles.get(parsed.id);
    if (owner !== undefined) {
      throw new Error(
        `${name} declares the id "${parsed.id}" already declared by ${owner}; ids must be unique within a pack`,
      );
    }
    idFiles.set(parsed.id, name);
    // Before any dispatch: a case that cannot be seeded is not a case, and
    // discovering that after two model calls wastes the budget the cap exists
    // to protect.
    for (const [key, content] of Object.entries(parsed.files)) {
      if (typeof content === "string") continue;
      const target = join(dir, ...content.fromFile.split("/"));
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(
          `${name} files key "${key}" fromFile "${content.fromFile}" does not exist in the pack directory`,
        );
      }
    }
    cases.push(parsed);
  }

  return { version: EVAL_PACK_VERSION, dir, cases };
}

// `roleDispatch` is the D9 row and lives beside the projection it carries
// (`src/eval-compare.ts`), which is where the six production parsers are
// imported. Re-exported here because the module table in `prd.md` D32 names
// this module as its home; the type-only import on the other side keeps the
// runtime edge one-directional.
export { roleDispatch, type EvalRoleDispatch } from "./eval-compare.js";
