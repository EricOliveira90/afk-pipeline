/**
 * The D9 dispatch table, the projection, and the comparison (`prd.md` D9).
 *
 * "Exact" means exact over a **named projection** of the role's parsed output
 * artifact: the top-level verdict enum plus, for `evaluator-qa`, the one named
 * secondary enum where the incident class lives. No findings, no ids, no
 * prose, no tree ids — so no projected field is a collection, and comparison
 * is field-by-field string equality.
 *
 * Every parser here is the **unmodified production parser** the pipeline
 * itself runs. A copy inside the harness would measure the copy.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  parseAcceptanceManifest,
} from "./acceptance-manifest.js";
import { type GuardianKind, parseGuardianReview } from "./artifacts.js";
import {
  CONTRACT_REVIEW_FILENAME,
  parseContractReview,
} from "./contract-review.js";
import { FINAL_REVIEW_FILENAME, parseFinalReview } from "./final-evaluation.js";
import {
  PLANNER_ESCALATION_FILENAME,
  readPlannerEscalation,
} from "./planner-escalation.js";
import { QA_REVIEW_FILENAME, parseQAReview } from "./qa-review.js";
import type { EvalExpected, EvalRole } from "./eval-pack.js";

/** `contract.md` beside the manifest: a CONTRACT is both files, not one. */
const CONTRACT_FILENAME = "contract.md";

/**
 * The `InvokeOptions` members the runner reproduces from production, verbatim.
 * `agent` and `bare` are *absent* keys for the planner and the evaluators
 * rather than `undefined` ones, because production does not pass them there
 * and the recorded call is the evidence B-09 asserts on.
 */
export interface EvalInvokeTemplate {
  role: string;
  agent?: string;
  bare?: true;
}

/**
 * One row of the D9 table. `project` takes the finished scratch directory
 * rather than the artifact's bytes because the planner's verdict *is* which
 * artifact it chose to write — a shape only the directory carries.
 *
 * Anything wrong with the artifact throws, and the runner turns a throw into
 * that case's `ERROR` (B-13): missing, ambiguous, or refused by the parser.
 */
export interface EvalRoleDispatch {
  readonly role: EvalRole;
  readonly invokeOptions: EvalInvokeTemplate;
  /** The artifact filename searched for recursively under the scratch dir. */
  readonly artifactFile: string;
  /** The unmodified production parser for that artifact. */
  readonly parse: (content: string, source: string) => unknown;
  /** The named projection (D9), over the finished scratch directory. */
  readonly project: (scratchDir: string) => EvalExpected;
}

/** Relative, forward-slashed, so a message is stable across temp roots. */
function display(scratchDir: string, path: string): string {
  return relative(scratchDir, path).split(/[\\/]/).join("/");
}

/**
 * Every file under `dir` whose base name is `name`, depth-first, sorted so a
 * two-match error message lists the same paths in the same order every run.
 */
function findByName(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory the role made unreadable is not a match; the caller's
      // "wrote no <file>" message is the honest report.
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

/** Exactly one match, parsed and projected; anything else throws (B-13). */
function projectOne<Parsed>(
  scratchDir: string,
  artifactFile: string,
  parse: (content: string, source: string) => Parsed,
  project: (parsed: Parsed) => EvalExpected,
): EvalExpected {
  const matches = findByName(scratchDir, artifactFile);
  const first = matches[0];
  if (first === undefined) {
    throw new Error(`role wrote no ${artifactFile}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `role wrote ${matches.length} ${artifactFile} files: ${matches.map((path) => display(scratchDir, path)).join(", ")}`,
    );
  }
  return project(parse(readFileSync(first, "utf-8"), display(scratchDir, first)));
}

/**
 * Build a row while keeping the parsed type honest inside it. The row's public
 * type is parser-agnostic, so the alternative is `any` at every call site.
 */
function row<Parsed>(spec: {
  role: EvalRole;
  invokeOptions: EvalInvokeTemplate;
  artifactFile: string;
  parse: (content: string, source: string) => Parsed;
  project: (parsed: Parsed) => EvalExpected;
}): EvalRoleDispatch {
  return {
    role: spec.role,
    invokeOptions: spec.invokeOptions,
    artifactFile: spec.artifactFile,
    parse: spec.parse,
    project: (scratchDir) =>
      projectOne(scratchDir, spec.artifactFile, spec.parse, spec.project),
  };
}

/** The guardians' row: `parseGuardianReview` never throws (D9). */
function guardianRow(kind: GuardianKind): EvalRoleDispatch {
  return row({
    role: kind,
    // `src/ship-gate.ts:707,754` — role and agent are the same string and
    // `bare` is true, so the provider runs the guardian's own agent config.
    invokeOptions: {
      role: `${kind}-review`,
      agent: `${kind}-review`,
      bare: true,
    },
    artifactFile: `review-${kind}.md`,
    parse: (content) => parseGuardianReview(content, kind),
    // `UNPARSEABLE` is a value, not a failure: an unparseable review against
    // an expected SHIP is the MISMATCH a maintainer wants to see as data.
    project: (parsed) => ({ outcome: parsed.outcome }),
  });
}

/**
 * The planner's row. Its verdict is which artifact it chose, so the sentinel
 * is read first: `readPlannerEscalation` takes the directory that holds it.
 */
const PLANNER_ROW: EvalRoleDispatch = {
  role: "planner",
  invokeOptions: { role: "planner" },
  // The artifact a CONTRACT is made of. The sentinel is a sentinel.
  artifactFile: ACCEPTANCE_MANIFEST_FILENAME,
  parse: (content, source) => parseAcceptanceManifest(content, source),
  project: (scratchDir) => {
    const sentinels = findByName(scratchDir, PLANNER_ESCALATION_FILENAME);
    if (sentinels.length > 1) {
      throw new Error(
        `role wrote ${sentinels.length} ${PLANNER_ESCALATION_FILENAME} files: ${sentinels.map((path) => display(scratchDir, path)).join(", ")}`,
      );
    }
    const sentinel = sentinels[0];
    if (sentinel !== undefined) {
      const record = readPlannerEscalation(dirname(sentinel));
      if (record === null) {
        // `readPlannerEscalation` found no sentinel where the walk did: the
        // role deleted it between the two reads. Not a projection.
        throw new Error(`role wrote no ${PLANNER_ESCALATION_FILENAME}`);
      }
      if (record.kind === "malformed") {
        throw new Error(
          `${PLANNER_ESCALATION_FILENAME} is malformed: ${record.defect}`,
        );
      }
      return { artifact: "ESCALATION" };
    }
    const manifests = findByName(scratchDir, ACCEPTANCE_MANIFEST_FILENAME);
    const manifest = manifests[0];
    if (manifest === undefined) {
      throw new Error(
        `role wrote neither ${PLANNER_ESCALATION_FILENAME} nor ${ACCEPTANCE_MANIFEST_FILENAME}`,
      );
    }
    if (manifests.length > 1) {
      throw new Error(
        `role wrote ${manifests.length} ${ACCEPTANCE_MANIFEST_FILENAME} files: ${manifests.map((path) => display(scratchDir, path)).join(", ")}`,
      );
    }
    parseAcceptanceManifest(
      readFileSync(manifest, "utf-8"),
      display(scratchDir, manifest),
    );
    // Beside it, not anywhere below it: a CONTRACT is the two files together,
    // and a `contract.md` in a sibling directory is a different claim.
    const contract = join(dirname(manifest), CONTRACT_FILENAME);
    if (!existsSync(contract)) {
      throw new Error(
        `role wrote ${display(scratchDir, manifest)} with no ${CONTRACT_FILENAME} beside it (${display(scratchDir, contract)})`,
      );
    }
    return { artifact: "CONTRACT" };
  },
};

const ROLE_DISPATCH: Readonly<Record<EvalRole, EvalRoleDispatch>> = {
  "evaluator-contract": row({
    role: "evaluator-contract",
    invokeOptions: { role: "evaluator-contract" },
    artifactFile: CONTRACT_REVIEW_FILENAME,
    parse: (content, source) => parseContractReview(content, source),
    project: (parsed) => ({ verdict: parsed.verdict }),
  }),
  "evaluator-qa": row({
    role: "evaluator-qa",
    invokeOptions: { role: "evaluator-qa" },
    artifactFile: QA_REVIEW_FILENAME,
    parse: (content, source) => parseQAReview(content, source),
    // Both keys required: the incident class is where an INFRASTRUCTURE
    // misread hides, and it is the reason this role has a second field.
    project: (parsed) => ({
      verdict: parsed.verdict,
      failureClass: parsed.failureClass,
    }),
  }),
  "evaluator-final": row({
    role: "evaluator-final",
    invokeOptions: { role: "evaluator-final" },
    artifactFile: FINAL_REVIEW_FILENAME,
    parse: (content, source) => parseFinalReview(content, source),
    // Not `baselineTreeId`/`finalTreeId`: a tree id differs on every run.
    project: (parsed) => ({ verdict: parsed.verdict }),
  }),
  planner: PLANNER_ROW,
  pm: guardianRow("pm"),
  architect: guardianRow("architect"),
};

/** The D9 row for a role: the invoke template, the artifact, the parser and
 * the projection the runner dispatches from (B-09). */
export function roleDispatch(role: EvalRole): EvalRoleDispatch {
  return ROLE_DISPATCH[role];
}

/**
 * The role's verdict, projected from what it actually wrote into
 * `scratchDir`. Throws on a missing, ambiguous or refused artifact — the
 * runner records that throw as the case's `ERROR` (B-13).
 */
export function projectOutput(role: EvalRole, scratchDir: string): EvalExpected {
  return roleDispatch(role).project(scratchDir);
}

/**
 * Field-by-field string equality over the projection (D9, D11). Pure.
 *
 * The key sets are compared too: `expected` was already validated against the
 * role, so a key-set difference here would mean the projection and the schema
 * disagree, and silently ignoring the extra field would report `MATCH` for a
 * comparison that never happened.
 */
export function compareProjection(
  expected: EvalExpected,
  actual: EvalExpected,
): "MATCH" | "MISMATCH" {
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return "MISMATCH";
  }
  return "MATCH";
}
