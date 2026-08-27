/**
 * One-off vitest reporter: prints wall-clock duration of each top-level
 * `describe` block, hooks included, so a file split can be balanced by
 * measured time. Not wired into any script; used ad hoc via
 * `--reporter=default --reporter=./scripts/describe-times.reporter.mjs`.
 */
export default class DescribeTimesReporter {
  onFinished(files = []) {
    for (const file of files) {
      console.log(`\n[describe-times] ${file.name}`);
      for (const task of file.tasks ?? []) {
        const ms = task.result?.duration;
        console.log(
          `[describe-times]   ${(ms === undefined ? "?" : (ms / 1000).toFixed(1) + "s").padStart(8)}  ${task.name}`,
        );
      }
    }
  }
}
