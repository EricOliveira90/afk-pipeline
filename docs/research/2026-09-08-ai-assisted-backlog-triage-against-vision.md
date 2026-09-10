# AI-Assisted Backlog Triage Against a Vision Document

Research date: 2026-09-08. All sources accessed 2026-09-08. Claims are paraphrased from the linked sources; content was rephrased for compliance with licensing restrictions.

## The question

Every AFK PRD run produces agent-recommended follow-up work, and the maintainer adds ad-hoc ideas on top. The backlog is ballooning and the codebase is drifting more complicated than `docs/specs/afk-v2-plan.md` intended. Wanted: a repeatable, AI-assisted way to (a) filter which items are truly needed to reach the plan's vision, (b) enforce KISS/YAGNI on what does get implemented, and (c) stay coherent with the documented vision over months of iteration.

The repo already practices a strong subset of this: the refereed two-agent plan debate (`afk-v2-plan-debate.md`) produced a cut list with the arguments that killed each item, explicit re-open triggers, and L/C/E/R ratings (Leverage / Cost / Evidence / Reversibility, 1–5); ADRs record decisions; `AGENTS.md` steers agent behavior. The recommendation below extends those patterns rather than replacing them.

## Summary of recommendation

1. **Default answer is "no, and we don't track it."** Shape Up's strongest claim is that a standing backlog is a liability, not an asset — ideas that matter resurface on their own, carried back by a person with fresh context ([Bets, Not Backlogs](https://basecamp.com/shapeup/2.1-chapter-07)). The debate's cut list already embodies this; extend it from "one-time debate output" to the standing disposition for *every* new agent recommendation.
2. **Triage in batches at a betting-table moment, not continuously.** Run an AI triage pass over accumulated recommendations only when the next PRD is being scoped, with the vision doc and the cut list in context. Between those moments, recommendations go to a per-run holding file that nobody grooms ([The Betting Table](https://basecamp.com/shapeup/2.2-chapter-08)).
3. **Give the triage pass an explicit rubric grounded in YAGNI's four costs** — build, delay, carry, repair ([Fowler, Yagni](https://martinfowler.com/bliki/Yagni.html)) — expressed in the repo's existing L/C/E/R vocabulary, plus one new mandatory field: *which numbered vision goal does this serve?* No goal, no candidacy.
4. **Cap each PRD with an appetite, not an estimate.** Fix the time/slice budget first and let scope vary to fit it; if an item can't fit, shrink the problem definition rather than the quality ([Set Boundaries](https://basecamp.com/shapeup/1.2-chapter-03)).
5. **Record "no" durably.** Nygard's ADR format explicitly keeps reversed/rejected decisions visible with a status field so they stay decided ([Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)); the repo's re-open triggers are the right mechanism — require one on every cut, and make the triage agent check new proposals against existing cuts before rating them.
6. **Enforce KISS at implementation time via constitution-style gates the agent must pass or justify in writing.** GitHub's spec-kit demonstrates the pattern: simplicity and anti-abstraction gates in the plan template, a "no speculative features" checklist, and a Complexity Tracking section where any gate failure must be justified ([spec-kit, spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)). AFK's planner/evaluator prompts and `AGENTS.md` are the natural carriers.
7. **Make the simplicity rules checkable, not aspirational.** Anthropic's core guidance is that an agent needs a signal it can read — a check that passes or fails — or the human becomes the verification loop ([Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). Where a KISS rule can be made mechanical (new-file count, dependency additions, public-surface growth per slice), gate on it.

## Findings by territory

### 1. Scope-creep and backlog-triage discipline

**Fowler's YAGNI essay** ([martinfowler.com/bliki/Yagni.html](https://martinfowler.com/bliki/Yagni.html)) is the sharpest single tool for triaging agent recommendations, because it names four distinct costs of building a "presumptive feature" now:

- *cost of build* — effort spent on a feature that turns out unnecessary;
- *cost of delay* — the value of the thing you didn't build instead (Fowler treats this as the cost the build-now argument must beat);
- *cost of carry* — the presumptive feature's complexity taxes every other feature built until it becomes useful (or is removed);
- *cost of repair* — the "right feature built wrong": by the time it's needed, you've learned enough that it needs rework anyway.

Fowler cites Kohavi et al.'s finding that even carefully analyzed features improve their target metric only about a third of the time — so the prior on any speculative item is roughly 2:1 against. Two further points matter for this repo: YAGNI applies to *abstractions* as much as features (any abstraction that makes current code harder to understand is "presumed guilty"), and YAGNI is *not* a license to skip refactoring — it only works on a malleable, well-tested codebase. His mentoring heuristic is directly usable as a triage prompt: imagine the refactoring needed to add the capability later; if that's not much more expensive, don't build now.

**Shape Up** (Basecamp, Ryan Singer) supplies the process shell. Three chapters are load-bearing:

- [Set Boundaries](https://basecamp.com/shapeup/1.2-chapter-03): the *appetite* — a time budget set before design, the inverse of an estimate ("appetites start with a number and end with a design"). Fixed time, variable scope forces the trade-off decisions that unbounded scope never does. When something can't fit the appetite, the move is to narrow the problem definition, not extend the budget.
- [Bets, Not Backlogs](https://basecamp.com/shapeup/2.1-chapter-07): standing backlogs impose a constant grooming tax and a false feeling of being behind. Basecamp keeps *no* central backlog; departments keep decentralized lists they own, and nothing enters a betting cycle unless a person deliberately revives and lobbies for it, with fresh context. The closing argument: genuinely important ideas come back on their own; ones that don't recur probably weren't problems.
- [The Betting Table](https://basecamp.com/shapeup/2.2-chapter-08): decisions happen at an infrequent, batched moment between cycles, choosing among a *few* shaped options — never a grooming session over a big list.

**Cost of Delay / WSJF.** SAFe's official page ([framework.scaledagile.com/wsjf](https://framework.scaledagile.com/wsjf)) defines WSJF as relative cost of delay divided by relative job duration, and carries Reinertsen's dictum from *The Principles of Product Development Flow* that cost of delay is the one thing to quantify if you quantify only one. The primary source for the underlying economics is Reinertsen's book (print; not independently fetchable). Note the structural match with the repo's existing ratings: L/C is already a value-per-cost ratio in the WSJF family; E (evidence) plays the role RICE gives to confidence. There is no need to adopt a new scoring scheme — the existing one is a member of this family.

**RICE** ([Intercom's original post](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/), Sean McBride) contributes two ideas worth stealing without adopting the formula: (1) the *confidence* multiplier exists specifically to deflate exciting but unevidenced ideas — anything below 50% is labelled a moonshot; (2) Intercom explicitly says the score is a decision-support and trade-off-visibility tool, not a hard rule — working "out of order" is fine as long as the scoring makes the deviation visible. That is exactly how L/C/E/R is used in the plan debate.

**ICE (Sean Ellis).** No accessible primary source found — Ellis's original writing lived on GrowthHackers, and only secondary summaries are readily retrievable. Per the quality bar, ICE is noted here without a primary citation and is not load-bearing for the recommendation (RICE covers the same ground with a verifiable source).

**Now/Next/Later** ([Janna Bastow, "Why I Invented It"](https://www.prodpad.com/blog/invented-now-next-later-roadmap/); [ProdPad glossary](https://www.prodpad.com/glossary/now-next-later-roadmap/)): the three columns are *confidence horizons*, not dates — Now is understood work, Next is problems being validated, Later is strategic bets under consideration. Bastow's stated motive was replacing deadline formats that reward false precision. Useful here as the vocabulary for what survives triage: an item that passes the vision test but not the evidence test belongs in Later-with-a-trigger, which is exactly what the debate's re-open triggers already implement.

### 2. Vision as gating artifact

Pursued lightly, per the quality bar. The Amazon Working Backwards / PR-FAQ mechanism and Amplitude's North Star Playbook were not fetched from primary sources in this pass, so no claims are made from them here. The one observation worth recording: this repo already *has* its vision-gating artifact — `afk-v2-plan.md` §1–3 plus the debate record — and the sources in territory 1 argue the gap is not a missing document but a missing *routine* that forces every new item through it. Building a second vision artifact would itself be a YAGNI violation.

### 3. Simplicity as design discipline

**Ousterhout, *A Philosophy of Software Design*.** The book is print-primary; his Stanford page ([web.stanford.edu/~ouster/cgi-bin/book.php](https://web.stanford.edu/~ouster/cgi-bin/book.php)) confirms the second edition's new chapter "Decide What Matters," which he summarizes as: good design is separating the important from the unimportant and concentrating on the important. That is a one-line statement of the triage problem itself. The book's broader thesis (complexity accumulates incrementally; each "just this once" special case compounds) is not quotable from a fetchable primary page, so it is attributed to the book generally rather than cited by page.

**Rich Hickey, "Simple Made Easy"** ([original Strange Loop 2011 talk, hosted at InfoQ](https://www.infoq.com/presentations/Simple-Made-Easy/)): simplicity — the absence of interleaving, "one twist" — is a prerequisite for reliability, and is objective, unlike "easy," which is relative to the beholder. The trap he names is choosing what is easy (at hand, familiar) and accumulating complexity as a result. For an agent pipeline the reading is direct: agents optimize for *easy* (the locally obvious edit, the extra wrapper, the new config knob) unless the harness makes *simple* the checked property.

**Fowler, Design Stamina Hypothesis** ([martinfowler.com/bliki/DesignStaminaHypothesis.html](https://martinfowler.com/bliki/DesignStaminaHypothesis.html)): design effort pays off by keeping the productivity gradient flat — neglect it and cumulative delivery falls behind past the "design payoff line," which Fowler judges to sit at *weeks*, not months. This is the counterweight that stops YAGNI-zealotry from cutting refactoring and test-health work: those items are what keep YAGNI viable, and they should not be triaged by the same "does it serve a vision goal" test as features. (Fowler is explicit about this boundary in the YAGNI essay too.)

### 4. AI-specific: keeping agents scoped

**Anthropic, Claude Code best practices** ([anthropic.com/engineering/claude-code-best-practices](https://www.anthropic.com/engineering/claude-code-best-practices)): the central discipline is giving the agent a check that produces a pass/fail signal it can read, because an agent stops when work *looks* done — without a check, the human is the verification loop and every mistake waits for a human to notice. The doc's escalation ladder (check in the prompt → goal condition → deterministic stop-hook gate → independent second-opinion agent) maps cleanly onto making KISS enforceable: a steering-file sentence is the weakest rung; a gate script counting new files/dependencies/public symbols is the strong rung. The doc also stresses that context-window degradation is the binding constraint — one more argument against feeding agents a sprawling backlog rather than a small, shaped slice.

**GitHub spec-kit** ([spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)) is the most complete published example of a *constitution* making an AI apply YAGNI mechanically:

- A `constitution.md` of immutable articles governs every generated plan; amendments require documented rationale and maintainer review.
- Paired **Simplicity and Anti-Abstraction articles** target over-engineering directly: minimal project structure (≤3 projects without written justification), use frameworks directly rather than wrapping them.
- The plan template enforces these as **"Phase -1" pre-implementation gates** — checklists the LLM must pass *before* implementation — and any gate failure must be justified in a **Complexity Tracking** section, creating a written accountability trail for each added layer.
- The spec template's checklist includes an explicit item rejecting speculative or "might need" features: everything must trace to a concrete user story.
- Templates force `[NEEDS CLARIFICATION]` markers instead of letting the LLM guess — the same instinct as AFK's planner-escalation mechanism.

The pattern to import is not spec-kit itself but its two moves: *rules live in a versioned constitution the agent must consult*, and *violations are allowed only with a written justification the reviewer can audit*.

**"Agents generate work faster than humans can review it."** No strong primary source found. The claim is ubiquitous in 2025–26 industry press and vendor blogs (e.g. [Signadot](https://www.signadot.com/blog/ai-generated-code-crisis/) on agents multiplying PR volume while validation capacity stays flat; a Gartner line about a critical review bottleneck circulates third-hand), but nothing located rises to the quality bar of an owning primary source with data. Treat it as a widely-reported practitioner observation — one this repo's own run history (agent-recommended follow-ups outpacing triage) independently confirms.

### 5. Decision-record discipline

**Nygard's original ADR post** ([Documenting Architecture Decisions, 2011](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)): the motivation is precisely the failure mode this repo is fighting — without recorded rationale, a newcomer (or a fresh agent context) can only blindly accept a past decision or blindly change it, and a project that accumulates blindly-accepted decisions "collapses under its own weight." Format points that matter here:

- One decision per short record; numbered, never reused; kept in the repo next to the code.
- The **Status** field is the mechanism for "it stays decided": reversed decisions are kept and marked superseded with a pointer to the replacement — the history of *was* the decision is itself information.
- Consequences must list negative and neutral outcomes, not just wins.

Nygard's post doesn't spell out "rejection ADRs" (recording *we will NOT do X*), but the format accommodates them trivially, and the repo already writes them in substance — the debate cut list with per-item kill arguments and re-open triggers *is* a batch of rejection records. The gap is only that they live in one debate document rather than being indexed where the triage pass (human or agent) will reliably re-encounter them.

## Proposed workflow (building on existing practice)

**A. Capture without grooming.** Agent-recommended follow-ups from each run land in a per-run holding file (they already land in run summaries). Nobody curates it between betting moments. This is Shape Up's decentralized-lists move: capture is cheap, the standing central backlog is what's forbidden ([Bets, Not Backlogs](https://basecamp.com/shapeup/2.1-chapter-07)).

**B. Batched AI triage at PRD-scoping time.** When the next PRD is being scoped, run one triage pass (a single agent session, or the existing two-agent debate format for contentious batches) over everything accumulated. Inputs pinned in context: `afk-v2-plan.md` §1 vision + §3 table, the cut list and its re-open triggers, and the rubric below. Output: a disposition per item.

**C. The rubric — each item gets:**
1. *Vision link:* which numbered plan goal does this serve? None ⇒ **Cut** (with reason recorded). This is the "strategy as constraint" test; the plan doc is the constraint.
2. *Prior-cut check:* does this match an existing cut-list entry? If yes and its re-open trigger has not fired ⇒ **Cut, cite the entry** — no re-rating. (Nygard's superseded-status discipline applied to rejections.)
3. *L/C/E/R rating* — unchanged from current practice; it already encodes WSJF-family value-per-cost (L/C) and RICE-style confidence (E).
4. *YAGNI test:* would deferring this until actually needed cost significantly more than building now, net of the ~2:1 prior against speculative features and the carry cost it adds meanwhile? ([Fowler](https://martinfowler.com/bliki/Yagni.html)). Default answer is no ⇒ **Later**.
5. *Exemption lane:* refactoring, test health, and gate reliability items are judged on design-stamina grounds (does this keep the codebase malleable?), not vision-goal grounds ([Fowler, Design Stamina](https://martinfowler.com/bliki/DesignStaminaHypothesis.html); YAGNI essay's malleability requirement).

**D. Dispositions are Now / Next / Later / Cut** — confidence horizons, not dates ([Bastow](https://www.prodpad.com/blog/invented-now-next-later-roadmap/)). *Now* = enters the PRD being scoped. *Later* and *Cut* both get a recorded reason and, where §6-style conditions exist, a re-open trigger; the difference is that Later items are expected back, Cut items require their trigger to fire. Append cuts to the standing cut list (or a `docs/adr/` rejection ADR when the cut is architecturally significant), so step C.2 keeps compounding.

**E. Appetite cap per PRD.** Before triage output is turned into tickets, fix the PRD's appetite — N slices / N agent-rounds — and cut scope to fit rather than extending it ([Set Boundaries](https://basecamp.com/shapeup/1.2-chapter-03)). An item that can't fit gets its problem definition narrowed or goes back to Later; it does not stretch the cycle.

**F. KISS gate at implementation time.** Two rungs, per the spec-kit and Anthropic patterns:
- *Constitution rung:* add a short simplicity article to `AGENTS.md` / the planner and generator prompts — no speculative capability, no wrapper around a framework feature, no new abstraction without a sentence of justification in the slice's plan — mirroring spec-kit's Phase -1 gates and Complexity Tracking section ([spec-kit](https://github.com/github/spec-kit/blob/main/spec-driven.md)).
- *Checkable rung:* where a rule can be mechanical, make it a gate the agent can fail and read: e.g. new-dependency count, new-file count, or exported-symbol growth beyond the ticket's declared surface flags the slice for evaluator attention. An unread steering sentence is the weakest enforcement; a pass/fail signal closes the loop ([Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)).

**G. What stays exactly as-is.** The refereed debate for major plan revisions, L/C/E/R, ADRs, planner escalation on load-bearing silences. The changes above are: the debate's *output conventions* (cut + reason + trigger) become the standing disposition format for routine triage; triage happens on a betting-table cadence with the vision doc pinned; and simplicity moves from culture to gate.

## Sources

Primary, deeply verified:
- Martin Fowler, *Yagni* — https://martinfowler.com/bliki/Yagni.html
- Martin Fowler, *Design Stamina Hypothesis* — https://martinfowler.com/bliki/DesignStaminaHypothesis.html
- Ryan Singer / Basecamp, *Shape Up*: ch. 3 *Set Boundaries* — https://basecamp.com/shapeup/1.2-chapter-03; ch. 7 *Bets, Not Backlogs* — https://basecamp.com/shapeup/2.1-chapter-07; ch. 8 *The Betting Table* — https://basecamp.com/shapeup/2.2-chapter-08
- Scaled Agile, *Weighted Shortest Job First* (carrying Reinertsen's cost-of-delay principle) — https://framework.scaledagile.com/wsjf
- Sean McBride / Intercom, *RICE: Simple prioritization for product managers* — https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/
- Janna Bastow / ProdPad, *Why I Invented the Now-Next-Later Roadmap* — https://www.prodpad.com/blog/invented-now-next-later-roadmap/ and glossary — https://www.prodpad.com/glossary/now-next-later-roadmap/
- Michael Nygard, *Documenting Architecture Decisions* — https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- Anthropic, *Claude Code best practices* — https://www.anthropic.com/engineering/claude-code-best-practices
- GitHub, *spec-kit* — *Spec-Driven Development* methodology doc — https://github.com/github/spec-kit/blob/main/spec-driven.md
- Rich Hickey, *Simple Made Easy* (Strange Loop 2011, hosted at InfoQ) — https://www.infoq.com/presentations/Simple-Made-Easy/
- John Ousterhout, *A Philosophy of Software Design* second-edition page (Stanford) — https://web.stanford.edu/~ouster/cgi-bin/book.php

Print-primary (cited via the above, not independently fetched):
- Donald Reinertsen, *The Principles of Product Development Flow* (via SAFe WSJF page)
- Kohavi et al. on feature success rates (via Fowler's YAGNI essay, footnote 3)

Not found at primary-source quality (noted honestly, not load-bearing):
- Sean Ellis's original ICE writing (GrowthHackers-era posts not retrievable)
- A primary, data-backed source for "agents generate work faster than humans can review it" — only 2025–26 industry press and vendor blogs located, e.g. https://www.signadot.com/blog/ai-generated-code-crisis/ (secondary)
- Amazon Working Backwards / PR-FAQ and Amplitude North Star Playbook — not pursued to primary depth in this pass; territory 2 explains why the gap is a routine, not a missing vision artifact
