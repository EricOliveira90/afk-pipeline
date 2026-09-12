/**
 * Unit tests for the prompt recorder (#264). Everything here is a pure unit
 * test against a fake inner provider and a temp directory — no pipeline is
 * spawned, per AGENTS.md's assertion ladder.
 *
 * The two docs assertions (B-09) live here rather than in a docs suite: this
 * is the suite of the module both docs describe, and the repo has no docs
 * test file to extend.
 */
import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WriteStream } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
  StreamEvent,
} from "./agent-provider.js";
import { EVENTS_SCHEMA_VERSION, type RunEventPayload } from "./run-events.js";
import { parsePipelineRuntimeOptions } from "./cli-options.js";
import { providerForRun, withPromptRecording } from "./prompt-recorder.js";

const RESULT: InvokeResult = { exitCode: 0, stdout: "inner stdout", stats: {} };

const tempDirs: string[] = [];
const streams: WriteStream[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-prompt-recorder-"));
  tempDirs.push(dir);
  return dir;
}

function openStream(path: string): WriteStream {
  const stream = createWriteStream(path, { flags: "a" });
  streams.push(stream);
  return stream;
}

interface FakeProvider extends AgentProvider {
  readonly calls: InvokeOptions[];
}

function makeInner(options: { parses?: boolean } = {}): FakeProvider {
  const calls: InvokeOptions[] = [];
  const provider: FakeProvider = {
    name: "fake-backend",
    calls,
    invoke: async (invokeOptions) => {
      calls.push(invokeOptions);
      return RESULT;
    },
  };
  if (options.parses) {
    provider.parseStreamLine = (line: string): StreamEvent[] => [
      { type: "text", text: line },
    ];
  }
  return provider;
}

function invokeOptions(
  prompt: string,
  logStream?: WriteStream,
): InvokeOptions {
  return { role: "generator", prompt, cwd: "/nowhere", logStream };
}

/**
 * Records only. A `createWriteStream` target appears on disk asynchronously,
 * so asserting the directory's whole listing would race the log's own
 * creation; what these tests are about is whether a record was written.
 */
function records(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".prompt."));
}

afterEach(async () => {
  // Awaited, not fire-and-forget: `createWriteStream` opens its fd
  // asynchronously, so removing the temp directory first makes the pending
  // open throw ENOENT as an uncaught exception.
  await Promise.all(
    streams.splice(0).map(
      (stream) =>
        new Promise<void>((done) => {
          stream.close(() => done());
        }),
    ),
  );
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("withPromptRecording", () => {
  it("B-02 writes the prompt's exact bytes beside the invocation log", async () => {
    const dir = makeTempDir();
    const logPath = join(dir, "slice-01-generator-r2.log");
    // No trailing newline, a fenced block and a non-ASCII character: the
    // record is the envelope's bytes, so all three must survive verbatim.
    const prompt = "# Envelope\n\n```ts\nconst x = 1;\n```\n\nDone — ✓";

    const result = await withPromptRecording(makeInner()).invoke(
      invokeOptions(prompt, openStream(logPath)),
    );

    const recordPath = join(dir, "slice-01-generator-r2.prompt.md");
    expect(readFileSync(recordPath, "utf-8")).toBe(prompt);
    expect(readFileSync(recordPath, "utf-8").endsWith("✓")).toBe(true);
    expect(result).toBe(RESULT);
  });

  it("B-03 takes the lowest free integer instead of overwriting a record", async () => {
    const dir = makeTempDir();
    const logPath = join(dir, "slice-01-planner.log");
    const wrapped = withPromptRecording(makeInner());

    // Three invocations against the same log path — what an append-mode
    // reopen in the same round produces.
    await wrapped.invoke(invokeOptions("first", openStream(logPath)));
    await wrapped.invoke(invokeOptions("second", openStream(logPath)));
    await wrapped.invoke(invokeOptions("third", openStream(logPath)));

    expect(readFileSync(join(dir, "slice-01-planner.prompt.md"), "utf-8")).toBe(
      "first",
    );
    expect(
      readFileSync(join(dir, "slice-01-planner.prompt.2.md"), "utf-8"),
    ).toBe("second");
    expect(
      readFileSync(join(dir, "slice-01-planner.prompt.3.md"), "utf-8"),
    ).toBe("third");
  });

  it("B-03 fills a gap left by a hand-removed record", async () => {
    const dir = makeTempDir();
    const logPath = join(dir, "slice-02-explorer.log");
    writeFileSync(join(dir, "slice-02-explorer.prompt.md"), "kept", "utf-8");

    await withPromptRecording(makeInner()).invoke(
      invokeOptions("next", openStream(logPath)),
    );

    expect(readFileSync(join(dir, "slice-02-explorer.prompt.md"), "utf-8")).toBe(
      "kept",
    );
    expect(
      readFileSync(join(dir, "slice-02-explorer.prompt.2.md"), "utf-8"),
    ).toBe("next");
  });

  it("B-04 is transparent about name, parseStreamLine and the inner result", async () => {
    const parsing = makeInner({ parses: true });
    const silent = makeInner();

    const wrappedParsing = withPromptRecording(parsing);
    const wrappedSilent = withPromptRecording(silent);

    expect(wrappedParsing.name).toBe(parsing.name);
    expect(wrappedSilent.name).toBe(silent.name);
    // Forwarded when the inner defines one; absent — not undefined-valued —
    // when it does not, because stream parsing is provider-optional
    // (ADR 0004) and a present member would claim a parser that isn't there.
    expect(wrappedParsing.parseStreamLine?.("hello")).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect("parseStreamLine" in wrappedSilent).toBe(false);
    expect(await wrappedSilent.invoke(invokeOptions("no stream"))).toBe(RESULT);
  });

  it("B-05 writes nothing for an invocation with no log stream", async () => {
    const dir = makeTempDir();
    const inner = makeInner();

    const result = await withPromptRecording(inner).invoke(
      invokeOptions("unlogged"),
    );

    expect(readdirSync(dir)).toEqual([]);
    expect(result).toBe(RESULT);
    expect(inner.calls).toHaveLength(1);
  });

  it("B-10 writes nothing when the stream's path yields no .log sibling", async () => {
    const dir = makeTempDir();
    const inner = makeInner();
    // The ship gate's guardian stream shape, but deliberately not a `.log`:
    // no fallback name is invented, because a record that does not sit
    // beside a log is not the artifact **Prompt record** promises.
    const stream = openStream(join(dir, "guardian-review.txt"));

    const result = await withPromptRecording(inner).invoke(
      invokeOptions("odd path", stream),
    );

    expect(records(dir)).toEqual([]);
    expect(existsSync(join(dir, "guardian-review.prompt.md"))).toBe(false);
    expect(result).toBe(RESULT);
    expect(inner.calls).toHaveLength(1);
  });

  it("B-10 writes nothing when the stream carries no path at runtime", async () => {
    const dir = makeTempDir();
    const pathless = { path: undefined } as unknown as WriteStream;

    const result = await withPromptRecording(makeInner()).invoke(
      invokeOptions("no path", pathless),
    );

    expect(readdirSync(dir)).toEqual([]);
    expect(result).toBe(RESULT);
  });
});

describe("providerForRun", () => {
  it("B-08 wraps the provider for a flagged argv and records when invoked", async () => {
    const dir = makeTempDir();
    const inner = makeInner();
    const { recordPrompts } = parsePipelineRuntimeOptions([
      "--prd-dir",
      "x",
      "--record-prompts",
    ]);

    const provider = providerForRun(inner, recordPrompts);

    expect(provider).not.toBe(inner);
    expect(provider.name).toBe(inner.name);
    await provider.invoke(
      invokeOptions("recorded", openStream(join(dir, "slice-01-qa-r11.log"))),
    );
    expect(
      readFileSync(join(dir, "slice-01-qa-r11.prompt.md"), "utf-8"),
    ).toBe("recorded");
  });

  it("B-06 B-08 returns the identical provider for an unflagged argv", async () => {
    const dir = makeTempDir();
    const inner = makeInner();
    const { recordPrompts } = parsePipelineRuntimeOptions(["--prd-dir", "x"]);

    const provider = providerForRun(inner, recordPrompts);

    // Reference equality is the observable: nothing was wrapped, so nothing
    // can record.
    expect(provider).toBe(inner);
    await provider.invoke(
      invokeOptions("not recorded", openStream(join(dir, "slice-01-qa.log"))),
    );
    expect(records(dir)).toEqual([]);
  });
});

describe("run-started evidence types", () => {
  it("B-07 P-03 keeps the recordPrompts field additive on run-started", () => {
    // Additive field, so no schema bump — the precedent at
    // src/run-events.ts:235-236 and :252-253.
    expect(EVENTS_SCHEMA_VERSION).toBe(1);
    // A historical stream carries no recordPrompts key and still reads as a
    // run-started payload.
    const historical: RunEventPayload = {
      type: "run-started",
      provider: "kiro",
      runSlug: "demo-kiro",
    };
    expect(historical).not.toHaveProperty("recordPrompts");
    const current: RunEventPayload = {
      type: "run-started",
      provider: "kiro",
      runSlug: "demo-kiro",
      recordPrompts: false,
    };
    expect(current).toHaveProperty("recordPrompts", false);
  });
});

describe("prompt-record documentation", () => {
  it("B-09 documents the Prompt record term and the recorder's module home", () => {
    const context = readFileSync(resolve("CONTEXT.md"), "utf-8");
    expect(context).toContain("**Prompt record**:");
    expect(context).toContain(
      "The `slice-<NN>-<role>[-r<N>].prompt.md` file `--record-prompts` writes beside",
    );
    expect(context).toContain(
      '_Avoid_: "prompt log", "transcript", "envelope dump"',
    );
    // Under "Pipeline concepts", not one of the agent sections.
    expect(context.indexOf("**Prompt record**:")).toBeGreaterThan(
      context.indexOf("### Pipeline concepts"),
    );

    const architecture = readFileSync(resolve("ARCHITECTURE.md"), "utf-8");
    const cliRow = architecture
      .split(/\r?\n/)
      .find((line) => line.startsWith("| CLI entries |"))!;
    expect(cliRow).toContain("`src/prompt-recorder.ts`");
    // The internals column, not the public seam.
    const columns = cliRow.split("|");
    expect(columns.at(-2)).toContain("`src/prompt-recorder.ts`");
  });
});
