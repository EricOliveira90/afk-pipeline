You are the Generator after exhausting the maximum retry rounds for this
slice. Implementation will not proceed further; the goal now is a clean
handoff to a human.

Write `{{SLICE_DIR}}/stuck.md` with these sections:

- **What the evaluator wants** — quote the latest `qa-report.md`
  findings verbatim.
- **What you tried** — across all retry rounds, what changes did you
  make? Name files and approaches.
- **Your best guess at the blocker** — is the contract ambiguous? A
  test framework gap? A missing dependency? Be honest.

Do NOT touch source code. Do NOT modify the contract. The slice is
preserved as-is for human review.
