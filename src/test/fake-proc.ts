import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { vi } from "vitest";

export interface FakeProc extends EventEmitter {
  pid: number | undefined;
  stdin: Writable;
  stdinText: string;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

export function makeFakeProc(pid: number | undefined = 100): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.stdinText = "";
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      proc.stdinText += chunk.toString();
      callback();
    },
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn(() => true);
  proc.unref = vi.fn();
  return proc;
}

export function emitExit(proc: FakeProc, code: number | null): void {
  proc.exitCode = code;
  proc.emit("exit", code);
}

export function asChildProcess(proc: FakeProc): ChildProcess {
  return proc as unknown as ChildProcess;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
