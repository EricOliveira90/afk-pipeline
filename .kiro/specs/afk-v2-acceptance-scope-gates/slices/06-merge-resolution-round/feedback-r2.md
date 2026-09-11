# Contract review — round 2 feedback

## What the revision settled

The new "Resolution tree model (one tree, stated once)" section does the work
round 1 asked for. There is now exactly one tree: the slice's own existing
worktree, with the feature tip merged into the slice branch there, the generator
resolving and committing on the slice branch, and an explicit failure
disposition — the resolution commit is kept and never reset (ADR 0039), the
feature tip is unmoved, both refs stay alive, and "both branches preserved" is
defined against exactly that. B-03, B-07 and B-10 now cite that model, B-10's
disposable worktree is gone, and B-04's contradictory "both branches at their
pre-resolution tips" is replaced by something the model can actually satisfy. The
Definition of done carries the matching no-reset check. That closes the round-1
blocking gap.

Three of the four advisories are closed too:

- B-08 now says `verdict` and `durationMs` in the contract bullet, the manifest's
  `then`, its `observableResult` and the test plan, and states those are the only
  two fields the payload owes. No `cost` remains.
- B-05 asserts non-reentrancy against the shared mutex instance, names the
  deadlock consequence, and binds it to an instrumented mutex that throws on
  reentrant acquisition — a test, not a convention.
- B-08 is named the deferrable tail, with the other nine declared indivisible and
  a reason given.

## What the revision opened

Picking one tree made a second question load-bearing, and the contract does not
answer it: what the resolution commit *is* relative to the in-progress merge.

Tree model steps 2 and 3 have the module run `git merge --no-commit` of the
feature tip into the slice branch, leave the conflicted index in place, and then
have the generator resolve and commit. A commit made in that state is a merge
commit whose second parent is the feature tip. If that is the intent, the feature
tip is an ancestor of the slice branch tip, so the retry of the slice branch into
the feature branch is a fast-forward that cannot conflict on content at all.

Two consequences follow, and both bite B-06:

1. B-06's newly named fixture lever — "a generator that re-conflicts the same
   lines instead of committing the merged content", with the gate phase stubbed
   to `PASS` — cannot produce a retry conflict under this model. Round 1 asked
   for a lever; the lever named is contradicted by the tree the same revision
   adopted, so B-06's scenario still has no reachable cause, and F-02 stays open
   for that reason.
2. Worse, the tree that lever describes would fast-forward onto the feature
   branch carrying conflict markers, and no behavior in the contract refuses it.
   The gate re-run is stubbed in that fixture precisely to model a gate-passing
   tree, so the gates are not the guard here.

The alternative reading — discard the merge state and commit a plain resolution,
so the retry is a real merge that can genuinely conflict — is nowhere in the
text, and B-03 ("treeId computed from the resolution commit") and B-04 ("still
reachable from the slice branch") read identically under either shape. So the
generator cannot tell which commit topology it owes, and the retry's meaning
changes completely depending on the answer.

## What has to change

State in the tree model whether the resolution commit carries the feature tip as
a parent, then make B-06 consistent with that choice: either name a path by which
the retry can still conflict, or, if the retry is a fast-forward, name the check
that refuses a resolved tree still containing conflict markers before it reaches
the feature branch. Fixing that also gives B-06 a lever that a fixture can
actually pull.

Nothing else in the revision needs to move.
