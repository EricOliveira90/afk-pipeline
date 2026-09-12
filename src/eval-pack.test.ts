import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_PACK_VERSION,
  EVAL_ROLES,
  SUPPORTED_EVAL_PACK_VERSIONS,
  readEvalPack,
  roleDispatch,
  validateEvalCase,
} from "./eval-pack.js";
import { evalCaseDocument, writeEvalPackDir } from "./eval.fixtures.js";
import { rmDirWithRetry } from "./test-support.js";

/**
 * Every refusing pack here lives in its own `mkdtemp` directory and none is
 * committed (scope lock): the only committed pack this slice adds is
 * `eval-packs/fixtures/refused/01-unknown-member.json`, asserted by B-28.
 */
describe("readEvalPack", () => {
  const dirs: string[] = [];
  const pack = (files: Record<string, unknown>): string => {
    const dir = writeEvalPackDir(files);
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmDirWithRetry(dir);
  });

  it("B-01 returns cases in byte-wise ascending file-name order with exactly the seven declared members", () => {
    const dir = pack({
      "20-third.json": evalCaseDocument({ id: "third" }),
      "02-second.json": evalCaseDocument({ id: "second" }),
      "01-first.json": evalCaseDocument({ id: "first" }),
      "10-fourth.json": evalCaseDocument({ id: "fourth" }),
    });

    const result = readEvalPack(dir);

    // "10-" sorts before "20-" and both after "02-": byte-wise, not numeric.
    expect(result.cases.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "fourth",
      "third",
    ]);
    expect(result.version).toBe(EVAL_PACK_VERSION);
    expect(result.dir).toBe(dir);
    for (const entry of result.cases) {
      expect(Object.keys(entry).sort()).toEqual([
        "expected",
        "files",
        "id",
        "prompt",
        "role",
        "source",
        "version",
      ]);
    }
  });

  it("B-01 scans only files directly inside the pack directory", () => {
    const dir = pack({
      "01-case.json": evalCaseDocument({ id: "only-case" }),
      "fixtures/99-not-a-case.json": evalCaseDocument({ id: "nested" }),
    });

    expect(readEvalPack(dir).cases.map((entry) => entry.id)).toEqual([
      "only-case",
    ]);
  });

  it("B-01 exports the role list and the pure validator", () => {
    expect(EVAL_ROLES).toEqual([
      "evaluator-contract",
      "evaluator-qa",
      "evaluator-final",
      "planner",
      "pm",
      "architect",
    ]);
    expect(SUPPORTED_EVAL_PACK_VERSIONS).toEqual([1]);
    // Pure: no directory exists, and the refusal still names the source.
    expect(validateEvalCase(evalCaseDocument(), "01-case.json").id).toBe(
      "case-01",
    );
    expect(() => validateEvalCase({}, "01-case.json")).toThrow(
      /01-case\.json is missing the top-level member "version"/,
    );
  });

  it("B-02 refuses the whole pack for an unknown top-level member, naming the file and the member", () => {
    const dir = pack({
      "01-good.json": evalCaseDocument({ id: "good" }),
      "02-extra.json": evalCaseDocument({ id: "extra", notes: "surplus" }),
    });

    expect(() => readEvalPack(dir)).toThrow(
      /02-extra\.json declares the unknown top-level member "notes"/,
    );
  });

  it("B-02 refuses the whole pack for a missing top-level member, naming the file and the member", () => {
    const document = evalCaseDocument({ id: "incomplete" });
    delete document.prompt;
    const dir = pack({ "01-missing.json": document });

    expect(() => readEvalPack(dir)).toThrow(
      /01-missing\.json is missing the top-level member "prompt"/,
    );
  });

  it("B-03 refuses a version outside SUPPORTED_EVAL_PACK_VERSIONS, naming the file", () => {
    const dir = pack({ "01-case.json": evalCaseDocument({ version: 2 }) });

    expect(() => readEvalPack(dir)).toThrow(
      /01-case\.json version 2 is not a supported eval pack version \(1\)/,
    );
  });

  it("B-03 refuses two case files that disagree on version, naming both files", () => {
    const dir = pack({
      "01-one.json": evalCaseDocument({ id: "one", version: 1 }),
      "02-two.json": evalCaseDocument({ id: "two", version: 2 }),
    });

    expect(() => readEvalPack(dir)).toThrow(
      /01-one\.json declares version 1 but 02-two\.json declares version 2/,
    );
  });

  it("B-04 refuses a role outside EVAL_ROLES, naming the file and the value", () => {
    const dir = pack({
      "01-case.json": evalCaseDocument({ role: "generator" }),
    });

    expect(() => readEvalPack(dir)).toThrow(
      /01-case\.json role "generator" is not an eval role \(evaluator-contract, /,
    );
  });

  it("B-05 validates expected against the case's role, naming the file and the key", () => {
    const missingKey = pack({
      "01-case.json": evalCaseDocument({
        role: "evaluator-qa",
        expected: { verdict: "PASS" },
      }),
    });
    expect(() => readEvalPack(missingKey)).toThrow(
      /01-case\.json expected is missing the key "failureClass" that role evaluator-qa projects/,
    );

    const extraKey = pack({
      "01-case.json": evalCaseDocument({
        expected: { verdict: "ACCEPT", failureClass: "NONE" },
      }),
    });
    expect(() => readEvalPack(extraKey)).toThrow(
      /01-case\.json expected declares the key "failureClass", which role evaluator-contract never projects/,
    );

    // A value the role's parser could never produce: `parseContractReview`
    // yields ACCEPT or REVISE, never PASS.
    const badValue = pack({
      "01-case.json": evalCaseDocument({ expected: { verdict: "PASS" } }),
    });
    expect(() => readEvalPack(badValue)).toThrow(
      /01-case\.json expected key "verdict" must be ACCEPT or REVISE for role evaluator-contract, not "PASS"/,
    );
  });

  it("B-06 refuses a files key that is absolute, relative-prefixed, dotted or drive-lettered", () => {
    const cases: Array<[string, RegExp]> = [
      ["/etc/passwd", /files key "\/etc\/passwd" must not start with "\/"/],
      ["./local.md", /files key "\.\/local\.md" must not start with "\.\/"/],
      ["../escape.md", /files key "\.\.\/escape\.md" must not contain a "\.\." segment/],
      ["C:/absolute.md", /files key "C:\/absolute\.md" must not carry a drive letter/],
    ];
    for (const [key, expected] of cases) {
      const dir = pack({
        "01-case.json": evalCaseDocument({ files: { [key]: "body" } }),
      });
      expect(() => readEvalPack(dir)).toThrow(expected);
    }
  });

  it("B-06 refuses a fromFile target that does not exist, at read time before any dispatch", () => {
    const dir = pack({
      "01-case.json": evalCaseDocument({
        files: { "contract.md": { fromFile: "fixtures/absent.md" } },
      }),
      "fixtures/present.md": "a different file",
    });

    expect(() => readEvalPack(dir)).toThrow(
      /01-case\.json files key "contract\.md" fromFile "fixtures\/absent\.md" does not exist in the pack directory/,
    );
  });

  it("B-06 accepts a fromFile target that exists and resolves it against the pack directory", () => {
    const dir = pack({
      "01-case.json": evalCaseDocument({
        files: { "contract.md": { fromFile: "fixtures/present.md" } },
      }),
      "fixtures/present.md": "seeded body",
    });

    expect(readEvalPack(dir).cases[0]?.files).toEqual({
      "contract.md": { fromFile: "fixtures/present.md" },
    });
  });

  it("B-07 refuses a duplicate id, naming both files", () => {
    const dir = pack({
      "01-one.json": evalCaseDocument({ id: "same" }),
      "02-two.json": evalCaseDocument({ id: "same" }),
    });

    expect(() => readEvalPack(dir)).toThrow(
      /02-two\.json declares the id "same" already declared by 01-one\.json/,
    );
  });

  it("B-07 refuses a malformed id, a blank source and a blank prompt", () => {
    const badId = pack({ "01-case.json": evalCaseDocument({ id: "Bad_Id" }) });
    expect(() => readEvalPack(badId)).toThrow(
      /01-case\.json id "Bad_Id" must match \^\[a-z0-9\]/,
    );

    const blankSource = pack({
      "01-case.json": evalCaseDocument({ source: "   " }),
    });
    expect(() => readEvalPack(blankSource)).toThrow(
      /01-case\.json source must be a non-blank string/,
    );

    const blankPrompt = pack({
      "01-case.json": evalCaseDocument({ prompt: "" }),
    });
    expect(() => readEvalPack(blankPrompt)).toThrow(
      /01-case\.json prompt must be a non-blank string/,
    );
  });

  it("B-07 refuses a directory with zero case files", () => {
    const empty = mkdtempSync(join(tmpdir(), "afk-eval-empty-"));
    dirs.push(empty);
    mkdirSync(join(empty, "fixtures"));
    writeFileSync(join(empty, "README.md"), "not a case", "utf-8");

    expect(() => readEvalPack(empty)).toThrow(/holds no \*\.json eval case files/);
  });

  it("B-09 exposes the D9 row through the re-export on src/eval-pack.ts", () => {
    // Re-exported here because `prd.md` D32's module table names this module as
    // `roleDispatch`'s home, while the row itself lives beside the projection.
    expect(roleDispatch("pm").invokeOptions).toEqual({
      role: "pm-review",
      agent: "pm-review",
      bare: true,
    });
  });
});

describe("the committed refusal pack", () => {
  const packDir = join("eval-packs", "fixtures", "refused");

  it("B-28 refuses eval-packs/fixtures/refused naming the unknown member", () => {
    expect(() => readEvalPack(packDir)).toThrow(
      /01-unknown-member\.json declares the unknown top-level member "notes"/,
    );
  });

  it("B-28 holds exactly one file, because every other refusing pack is a temporary directory", () => {
    // Bounded to the directory this slice owns: #263 adds packs elsewhere
    // under `eval-packs/` on the same feature branch.
    const listing: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else listing.push(relative(packDir, path).split(/[\\/]/).join("/"));
      }
    };
    walk(packDir);

    expect(listing.sort()).toEqual(["01-unknown-member.json"]);
  });
});
