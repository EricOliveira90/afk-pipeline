/**
 * The gate cache document, as a unit. Every miss path is asserted here rather
 * than through a spawned pipeline: the whole point of B-04 is that a cache can
 * only ever make a run cheaper, never redder, and that is a property of these
 * two functions.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GATE_CACHE_VERSION,
  gateCacheKeyOf,
  readGateCacheEntry,
  writeGateCacheEntry,
  type GateCacheEntry,
  type GateCacheKey,
} from "./gate-cache.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-gate-cache-"));
  tempDirs.push(dir);
  // A nested directory the writer has to create, as the real path does.
  return join(dir, "artifacts", "run-slug", "gate-cache.json");
}

const KEY: GateCacheKey = {
  gateId: "typecheck",
  command: "pnpm",
  args: ["run", "typecheck"],
  treeId: "a".repeat(40),
};

/** Write bytes the reader must cope with, at a path only this test creates. */
function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

function entryFor(key: GateCacheKey): GateCacheEntry {
  return {
    ...key,
    args: [...key.args],
    status: "PASS",
    durationMs: 18_000,
    exitCode: 0,
    recordedAt: new Date().toISOString(),
  };
}

describe("gate cache", () => {
  it("[behavior:B-03] records a PASS under gate id, command, args and tree id, and reuses it on an identical key", () => {
    const path = cachePath();
    const options = { path, enabled: true };
    expect(readGateCacheEntry(options, KEY)).toBe(null);

    writeGateCacheEntry(options, entryFor(KEY));
    const hit = readGateCacheEntry(options, KEY);
    expect(hit).toMatchObject({ status: "PASS", exitCode: 0 });

    // The whole key is in the document, so nothing about a reused answer is
    // inferred from the gate id alone.
    const document = JSON.parse(readFileSync(path, "utf-8"));
    expect(document.version).toBe(GATE_CACHE_VERSION);
    expect(Object.keys(document.entries)).toEqual([gateCacheKeyOf(KEY)]);
    // Args are JSON-encoded, so `["a b"]` and `["a","b"]` cannot collide.
    expect(gateCacheKeyOf({ ...KEY, args: ["run typecheck"] })).not.toBe(
      gateCacheKeyOf(KEY),
    );
  });

  it("[behavior:B-03] caches nothing but PASS", () => {
    const path = cachePath();
    const options = { path, enabled: true };
    writeGateCacheEntry(options, {
      ...entryFor(KEY),
      // A FAIL is a fact about a tree the next round exists to change, and an
      // INFRASTRUCTURE result is a fact about the machine.
      status: "FAIL" as unknown as "PASS",
    });
    expect(readGateCacheEntry(options, KEY)).toBe(null);
  });

  it("[behavior:B-04] misses on a different tree id, a different command and different args", () => {
    const options = { path: cachePath(), enabled: true };
    writeGateCacheEntry(options, entryFor(KEY));

    expect(readGateCacheEntry(options, { ...KEY, treeId: "b".repeat(40) })).toBe(
      null,
    );
    expect(readGateCacheEntry(options, { ...KEY, command: "npm" })).toBe(null);
    expect(
      readGateCacheEntry(options, { ...KEY, args: ["run", "typecheck", "-x"] }),
    ).toBe(null);
    // And still hits on the key it recorded.
    expect(readGateCacheEntry(options, KEY)).not.toBe(null);
  });

  it("[behavior:B-04] misses when the cache is disabled, and writes nothing", () => {
    const path = cachePath();
    writeGateCacheEntry({ path, enabled: false }, entryFor(KEY));
    expect(readGateCacheEntry({ path, enabled: false }, KEY)).toBe(null);
    // Nothing was written, so enabling it later does not resurrect an answer
    // recorded while the policy said not to.
    expect(readGateCacheEntry({ path, enabled: true }, KEY)).toBe(null);
    expect(readGateCacheEntry(undefined, KEY)).toBe(null);
  });

  it("[behavior:B-04] treats an absent, malformed, wrong-version or misfiled document as a miss and never throws", () => {
    const absent = { path: cachePath(), enabled: true };
    expect(readGateCacheEntry(absent, KEY)).toBe(null);

    const malformed = cachePath();
    writeGateCacheEntry({ path: malformed, enabled: true }, entryFor(KEY));
    writeRaw(malformed, "{ this is not json");
    expect(readGateCacheEntry({ path: malformed, enabled: true }, KEY)).toBe(
      null,
    );
    // A malformed document does not stop the next write either: the run pays
    // the gate and records it again.
    expect(() =>
      writeGateCacheEntry({ path: malformed, enabled: true }, entryFor(KEY)),
    ).not.toThrow();
    expect(readGateCacheEntry({ path: malformed, enabled: true }, KEY)).not.toBe(
      null,
    );

    const wrongVersion = cachePath();
    writeRaw(
      wrongVersion,
      JSON.stringify({
        version: GATE_CACHE_VERSION + 1,
        entries: { [gateCacheKeyOf(KEY)]: entryFor(KEY) },
      }),
    );
    expect(readGateCacheEntry({ path: wrongVersion, enabled: true }, KEY)).toBe(
      null,
    );

    // An entry filed under a key it does not describe — a hand-edited document
    // — must not answer for another gate.
    const misfiled = cachePath();
    writeRaw(
      misfiled,
      JSON.stringify({
        version: GATE_CACHE_VERSION,
        entries: { [gateCacheKeyOf(KEY)]: entryFor({ ...KEY, gateId: "lint" }) },
      }),
    );
    expect(readGateCacheEntry({ path: misfiled, enabled: true }, KEY)).toBe(
      null,
    );
  });
});
