# Contract review — round 3 (slice 06, merge-resolution round)

The revision settles the question the last round blocked on. The resolution
commit now has one stated shape, and the consequence of that shape is followed
all the way through to what reaches the feature branch.

## What the revision fixed

**The tree model commits to a shape (was F-06).** Step 3 now says the
in-progress merge is never discarded, so the resolution commit is a merge commit
whose first parent is the pre-round slice tip and whose second parent is the
feature tip that was merged in — and it records why the alternative (discard the
merge state, commit a plain resolution) was rejected. That is the ambiguity the
generator could not previously resolve.

**The consequence is stated, not left implied.** Step 6 draws the conclusion the
last round had to derive for the contract: with the feature tip already a parent
and the mutex held, the retry is a fast-forward, so a textual retry conflict is
unreachable. The ancestry reasoning holds. That in turn makes the gate re-run
*not* the last thing between a bad resolution and the feature branch, which is
exactly why step 7's guard is needed.

**The missing guard exists (was F-06's second half).** Step 7 adds a pre-retry
scan for line-start conflict markers over the previously conflicted paths' blobs
in the resolution merge commit; a hit refuses the retry and fails the round under
step 5's no-reset disposition. It is correctly framed as this slice's own guard
rather than a new catalog gate, and it is inside the widened critical section per
B-05. The Definition of done pins the property.

**The dependent behaviors now read one way.** B-03 pins `treeId` to that merge
commit's tree (`git rev-parse HEAD^{tree}`), B-04 and step 5 name the merge
commit as what stays on the slice branch, and the manifest's B-03/B-04/B-06
entries carry the same wording, so no behavior reads the same under both of the
old competing models.

**B-06's fixture is honest again (was F-02).** The contract no longer claims a
fixture for a retry conflict it cannot cause. It names the levers that are
actually reachable — markers in a file no gate reads (refused pre-retry, so the
retry never runs), a retry returning a prefix collision or a non-fast-forward
result (terminal `CONFLICT`, never `MERGE-PENDING`), and a pure unit test of the
scan — and each has a matching test-plan bullet.

## One thing worth tightening, not worth another round

Step 7's justification is broader than the check it introduces. The reason given
is that a resolved tree can carry markers in *any* file no gate reads, but the
scan covers only the paths conflicted in step 2, and the Definition-of-done item
inherits that narrowing. A generator that pastes a hunk with its markers into a
neighbouring unread file while resolving still fast-forwards onto the feature
branch. Scoping the scan to the conflicted paths is a reasonable cost choice —
scanning every blob in the merge commit is a different order of work — but the
contract does not say the choice was made. Either widen the scan to the paths the
resolution commit changed relative to its first parent, or add the one sentence
saying why the conflicted paths are treated as the whole risk surface. Advisory:
the implementer can settle this while building without re-negotiating.

## Minor note (no action required)

Step 6 says a prefix collision "is still possible on the retry". Under
`findMigrationPrefixCollisions`' same-prefix/different-filename rule, a pair that
would collide on the retry would already have collided on the first attempt and
gone down B-09's `MERGE-PENDING` path, so in practice this needs the resolution
itself to introduce a new migration file. The contract's handling (terminal
`CONFLICT`) is right either way, and the test-plan bullet reaches it by stubbing
the merge attempt, so nothing here is unbuildable.
