/**
 * Separates meaningful agent output from decorative terminal animation
 * for liveness detection. See ADR 0016.
 *
 * Failure mode this guards against: a hung `kiro-cli chat` session
 * renders an animated spinner ("\r⠋ Dividing up the work...") several
 * times per second, forever. Each frame arrives as a stdout chunk, and
 * a chunk-counts-as-activity liveness signal resets the idle watcher
 * on every frame — so the idle kill never fires and the invocation
 * hangs indefinitely.
 *
 * The model: text a spinner draws is transient — it rewrites the same
 * line in place via carriage return (or the equivalent ANSI cursor
 * controls) and never commits it with a newline. Output that survives
 * on the terminal is what counts as progress:
 *
 * - A newline committing a line with non-whitespace content.
 * - The current line growing beyond the longest it has been since the
 *   last commit (covers text streamed without newlines; a fixed-width
 *   spinner frame redraws to the same length and never trips this).
 *
 * ANSI escape sequences are stripped first; `ESC[nG` (cursor to
 * column) and `ESC[nK` (erase line) are treated as carriage returns
 * since both signal an in-place line rewrite.
 */

/** Cursor-to-column / erase-line controls that mark a line rewrite. */
const LINE_REWRITE_PATTERN = /\x1b\[[0-9]*[GK]/g;

/**
 * CSI sequences (colors, cursor visibility, ...), OSC sequences
 * (terminal title, hyperlinks), and single-character escapes.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\_^`])/g;

/**
 * A trailing fragment that might be the start of an escape sequence
 * split across chunk boundaries. Held back until the next chunk.
 */
const PARTIAL_ANSI_TAIL = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*)?$/;

/** Bound on the held-back fragment so a rogue stream can't grow it. */
const MAX_CARRY_LENGTH = 64;

export interface ProgressFilter {
  /**
   * Feed one raw stdout/stderr chunk. Returns true when the chunk
   * contains meaningful progress (per the module doc above).
   */
  update(chunk: string): boolean;
}

export function createProgressFilter(): ProgressFilter {
  /** Trailing possibly-partial ANSI sequence carried between chunks. */
  let carry = "";
  /** Length of the current (uncommitted) line. */
  let lineLength = 0;
  /** Whether the current line contains any non-whitespace. */
  let lineHasContent = false;
  /** Longest the line has been since the last newline commit. */
  let maxLineLength = 0;
  /** A bare `\r` was seen at the end of the previous chunk. */
  let pendingCarriageReturn = false;

  const resetLine = () => {
    lineLength = 0;
    lineHasContent = false;
  };

  return {
    update(chunk: string): boolean {
      let text = carry + chunk;
      carry = "";
      const tail = PARTIAL_ANSI_TAIL.exec(text);
      if (tail && tail[0].length > 0 && tail[0].length <= MAX_CARRY_LENGTH) {
        carry = tail[0];
        text = text.slice(0, -tail[0].length);
      }
      text = text
        .replace(LINE_REWRITE_PATTERN, "\r")
        .replace(ANSI_PATTERN, "");

      let progress = false;
      for (const ch of text) {
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          // `\r\n` is a plain line ending, not a rewrite — fall through
          // to the newline handling so CRLF lines still commit.
          if (ch !== "\n") resetLine();
        }
        if (ch === "\r") {
          // Defer: only a rewrite if NOT immediately followed by `\n`.
          pendingCarriageReturn = true;
        } else if (ch === "\n") {
          if (lineHasContent) progress = true;
          resetLine();
          maxLineLength = 0;
        } else {
          lineLength++;
          if (!/\s/.test(ch)) lineHasContent = true;
          if (lineHasContent && lineLength > maxLineLength) {
            maxLineLength = lineLength;
            progress = true;
          }
        }
      }
      return progress;
    },
  };
}
