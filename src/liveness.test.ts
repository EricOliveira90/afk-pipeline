import { describe, it, expect } from "vitest";
import { createProgressFilter } from "./liveness.js";

/**
 * Real spinner frame shape captured from a hung generator invocation
 * (slice-06-generator-r1.log): carriage return, braille glyph, fixed
 * text — repainted several times per second, never newline-committed.
 */
const SPINNER_FRAMES = [
  "\r⠋ Dividing up the work...",
  "\r⠙ Dividing up the work...",
  "\r⠹ Dividing up the work...",
  "\r⠸ Dividing up the work...",
  "\r⠼ Dividing up the work...",
];

describe("createProgressFilter", () => {
  it("counts a committed line with content as progress", () => {
    const filter = createProgressFilter();
    expect(filter.update("PASS src/foo.test.ts\n")).toBe(true);
  });

  it("does not count whitespace-only lines", () => {
    const filter = createProgressFilter();
    expect(filter.update("\n")).toBe(false);
    expect(filter.update("   \n\t\n")).toBe(false);
  });

  it("counts CRLF-terminated lines (Windows child output)", () => {
    const filter = createProgressFilter();
    expect(filter.update("compiled 3 files\r\n")).toBe(true);
    expect(filter.update("done\r\n")).toBe(true);
  });

  it("suppresses repeated spinner frames after the first", () => {
    const filter = createProgressFilter();
    // First frame legitimately grows the line — one reset is fine.
    expect(filter.update(SPINNER_FRAMES[0]!)).toBe(true);
    // Every subsequent repaint of the same-width frame is decorative.
    for (let i = 0; i < 200; i++) {
      const frame = SPINNER_FRAMES[(i + 1) % SPINNER_FRAMES.length]!;
      expect(filter.update(frame)).toBe(false);
    }
  });

  it("suppresses a burst of many frames arriving in one chunk", () => {
    const filter = createProgressFilter();
    filter.update(SPINNER_FRAMES[0]!);
    const burst = SPINNER_FRAMES.join("").repeat(20);
    expect(filter.update(burst)).toBe(false);
  });

  it("still detects a real line interleaved between spinner frames", () => {
    const filter = createProgressFilter();
    filter.update(SPINNER_FRAMES[0]!);
    filter.update(SPINNER_FRAMES[1]!);
    expect(filter.update("\r\n> Reading file: src/index.ts\n")).toBe(true);
    // Spinner resumes — silent again, even though the newline commit
    // reset the growth watermark (the first frame after a commit
    // re-arms once, then the repaint loop stays silent).
    filter.update(SPINNER_FRAMES[2]!);
    expect(filter.update(SPINNER_FRAMES[3]!)).toBe(false);
  });

  it("treats ESC[nG cursor-to-column repaints like carriage returns", () => {
    const filter = createProgressFilter();
    filter.update("\x1b[1G⠋ Working...");
    expect(filter.update("\x1b[1G⠙ Working...")).toBe(false);
    expect(filter.update("\x1b[1G\x1b[2K⠹ Working...")).toBe(false);
  });

  it("counts text streamed without newlines as it grows", () => {
    const filter = createProgressFilter();
    expect(filter.update("Implementing the ")).toBe(true);
    expect(filter.update("parser module ")).toBe(true);
    expect(filter.update("now")).toBe(true);
  });

  it("ignores ANSI colour and cursor-visibility noise", () => {
    const filter = createProgressFilter();
    filter.update("\r⠋ Dividing up the work...");
    // Pure ANSI chatter — cursor hide/show, colour resets.
    expect(filter.update("\x1b[?25l\x1b[0m\x1b[38;5;141m")).toBe(false);
    expect(filter.update("\x1b[?25h\x1b[0m")).toBe(false);
  });

  it("does not leak progress from an ANSI sequence split across chunks", () => {
    const filter = createProgressFilter();
    filter.update("\r⠋ Dividing up the work...");
    // "\x1b[38;5;1" + "41m" would read as literal "41m" without carry.
    expect(filter.update("\x1b[38;5;1")).toBe(false);
    expect(filter.update("41m")).toBe(false);
  });

  it("handles a CR at a chunk boundary as a rewrite, not a commit", () => {
    const filter = createProgressFilter();
    filter.update("\r⠋ Dividing up the work...");
    // Chunk ends exactly on the CR; the next chunk is the repaint.
    expect(filter.update("\r")).toBe(false);
    expect(filter.update("⠙ Dividing up the work...")).toBe(false);
    // ...but CR + \n split across chunks is still a line commit.
    filter.update("real output\r");
    expect(filter.update("\n")).toBe(true);
  });

  it("counts a growing CR-progress indicator only when it grows", () => {
    const filter = createProgressFilter();
    expect(filter.update("\rtests 1/100")).toBe(true);
    // Same width — repaint.
    expect(filter.update("\rtests 2/100")).toBe(false);
    // Wider — genuine growth.
    expect(filter.update("\rtests 10/100")).toBe(true);
  });
});
