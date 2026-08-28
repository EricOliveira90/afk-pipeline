import { describe, expect, it } from "vitest";
import {
  cancellationSignalsFor,
  installCancellationSignals,
  type SignalHost,
} from "./cancellation.js";

/**
 * A fake `process` that records registrations and lets a test deliver a
 * signal by name.
 */
function makeHost(platform: string) {
  const listeners = new Map<string, Array<() => void>>();
  const exits: number[] = [];
  const host: SignalHost = {
    platform,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return host;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return host;
    },
    exit(code) {
      exits.push(code);
      return undefined;
    },
  };
  return {
    host,
    exits,
    registered: () => [...listeners.keys()].filter((k) => listeners.get(k)!.length > 0),
    deliver(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  };
}

/**
 * The stop button. Issue #114: the run was launched into its own Windows
 * process group, where the OS disables Ctrl-C — `CTRL_C_EVENT` never
 * arrived. `CTRL_BREAK_EVENT` did, but nothing listened for SIGBREAK, so
 * Node took the default action and terminated the process, skipping the
 * abort path and every record it writes.
 */
describe("installCancellationSignals", () => {
  it("registers SIGBREAK on Windows — the only console event a new process group receives", () => {
    expect(cancellationSignalsFor("win32")).toContain("SIGBREAK");
    // SIGINT stays: it is what a foreground Ctrl-C delivers.
    expect(cancellationSignalsFor("win32")).toContain("SIGINT");
    // Windows never delivers these, so listening for them would be
    // decoration; POSIX gets them because `kill` and terminal-close do.
    expect(cancellationSignalsFor("win32")).not.toContain("SIGTERM");
    expect(cancellationSignalsFor("linux")).toEqual([
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
    ]);
  });

  it("aborts on SIGBREAK, not only SIGINT", () => {
    const fake = makeHost("win32");
    const handle = installCancellationSignals({ host: fake.host, log: () => {} });

    expect(handle.signal.aborted).toBe(false);
    fake.deliver("SIGBREAK");
    expect(handle.signal.aborted).toBe(true);
    expect(fake.exits).toEqual([]);
  });

  it("aborts on the first signal and exits hard on the second, whichever signals they are", () => {
    const fake = makeHost("win32");
    const logged: string[] = [];
    const handle = installCancellationSignals({
      host: fake.host,
      log: (message) => logged.push(message),
    });

    fake.deliver("SIGINT");
    expect(handle.signal.aborted).toBe(true);
    expect(fake.exits).toEqual([]);

    // A mixed pair still escalates: two stop requests are two stop
    // requests, whatever the operator's tooling had to send.
    fake.deliver("SIGBREAK");
    expect(fake.exits).toEqual([130]);
    expect(logged.join("\n")).toContain("Second stop request (SIGBREAK)");
  });

  /**
   * The `afk stop` sentinel is the same button (ADR 0041) — the pipeline
   * presses it when it finds the sentinel, because a detached Windows run
   * cannot be reached by a console event at all.
   */
  it("aborts on requestStop, and counts it toward the hard-exit escalation", () => {
    const fake = makeHost("win32");
    const logged: string[] = [];
    const handle = installCancellationSignals({
      host: fake.host,
      log: (message) => logged.push(message),
    });

    handle.requestStop("stop sentinel");
    expect(handle.signal.aborted).toBe(true);
    expect(fake.exits).toEqual([]);
    expect(logged[0]).toContain("Stop requested by stop sentinel");

    // A sentinel followed by a Ctrl-Break is an operator asking twice.
    fake.deliver("SIGBREAK");
    expect(fake.exits).toEqual([130]);
  });

  it("names the signal it received, so an operator can tell which one landed", () => {
    const fake = makeHost("win32");
    const logged: string[] = [];
    installCancellationSignals({
      host: fake.host,
      log: (message) => logged.push(message),
    });

    fake.deliver("SIGBREAK");
    expect(logged[0]).toContain("Received SIGBREAK");
  });

  it("removes every listener on dispose", () => {
    const fake = makeHost("linux");
    const handle = installCancellationSignals({ host: fake.host, log: () => {} });

    expect(fake.registered()).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    handle.dispose();
    expect(fake.registered()).toEqual([]);
  });
});
