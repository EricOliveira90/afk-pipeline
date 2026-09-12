/**
 * Prompt recorder (#264, PRD 7 D1/D6).
 *
 * `--record-prompts` writes every provider invocation's exact prompt to a
 * `.prompt.md` file beside that invocation's `.log` in the run directory, so
 * a past incident can become an eval case from a recording instead of a hand
 * reconstruction. See CONTEXT.md **Prompt record**.
 *
 * Placement is a provider decorator at ADR 0002's `AgentProvider` seam — the
 * first one in the repo. No provider, `src/invocation-runtime.ts` or
 * `InvokeOptions` change: the record's name is derived from the log stream
 * the orchestrator already opens (`RunJournal.agentLog`,
 * `src/logger.ts:243-247`), so the record inherits whatever slice, role,
 * round and attempt encoding that log already carries.
 */
import { existsSync, writeFileSync } from "node:fs";
import type { AgentProvider, InvokeOptions } from "./agent-provider.js";

const LOG_SUFFIX = ".log";

/**
 * Derive the record's path from the log's, or return undefined when there is
 * no sibling to write.
 *
 * The lowest free integer, scanned upward: a log is opened in append mode
 * because one filename can be legitimately reopened within a run
 * (`src/logger.ts:234-241`), and each record must stay one copy-pasteable
 * prompt, so a second invocation against the same log takes
 * `….prompt.2.md`, a third `….prompt.3.md`. Nothing is appended to and
 * nothing is overwritten.
 *
 * A path that does not end in `.log` yields no name at all rather than a
 * fabricated one: a record that does not sit beside a log is not the
 * artifact **Prompt record** promises. Unreachable from production, where
 * every `logStream` comes from `RunJournal.agentLog`.
 */
function recordPathForLog(logPath: string): string | undefined {
  if (!logPath.endsWith(LOG_SUFFIX)) return undefined;
  const base = logPath.slice(0, -LOG_SUFFIX.length);
  const first = `${base}.prompt.md`;
  if (!existsSync(first)) return first;
  for (let k = 2; ; k++) {
    const candidate = `${base}.prompt.${k}.md`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Write this invocation's prompt beside its log, or write nothing.
 *
 * Three ways to write nothing, all silent and none fatal: no `logStream` at
 * all (a future unlogged call site is already unlogged), a stream whose
 * `path` is absent at runtime, and a path that is not a `.log`.
 */
function recordPrompt(options: InvokeOptions): void {
  const stream = options.logStream;
  if (stream === undefined) return;
  // `node:fs`'s WriteStream declares `path: string | Buffer`; read it as
  // unknown so a runtime-absent member is a skip rather than a type error,
  // and so nothing in src/agent-provider.ts has to be widened.
  const rawPath: unknown = stream.path;
  if (rawPath === undefined || rawPath === null) return;
  const recordPath = recordPathForLog(String(rawPath));
  if (recordPath === undefined) return;
  // `wx` is the guarantee, not an optimisation: the scan above chose a free
  // name, and the flag refuses to append to or overwrite a record if that
  // ever stops being true.
  writeFileSync(recordPath, options.prompt, { encoding: "utf-8", flag: "wx" });
}

/**
 * Wrap a provider so every invocation records its prompt. Transparent
 * otherwise: `name` is the inner's (it drives branch and run-slug
 * namespacing — ADR 0002), `parseStreamLine` is forwarded when the inner
 * defines one and absent when it does not (ADR 0004: stream parsing is
 * provider-optional), and `invoke` resolves to the inner provider's result
 * unchanged.
 */
export function withPromptRecording(inner: AgentProvider): AgentProvider {
  const wrapped: AgentProvider = {
    name: inner.name,
    invoke: (options) => {
      recordPrompt(options);
      return inner.invoke(options);
    },
  };
  if (inner.parseStreamLine) {
    wrapped.parseStreamLine = (line) => inner.parseStreamLine!(line);
  }
  return wrapped;
}

/**
 * The one flag-on/flag-off decision every CLI entry uses, so the wiring is a
 * unit-testable value rather than three inline conditionals. Flag off returns
 * the identical `inner` reference — nothing was wrapped, so nothing can
 * record.
 */
export function providerForRun(
  inner: AgentProvider,
  recordPrompts?: boolean,
): AgentProvider {
  return recordPrompts === true ? withPromptRecording(inner) : inner;
}
