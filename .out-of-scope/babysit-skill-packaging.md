# Babysit-Skill Packaging

AFK does not ship the babysit workflow as a packaged skill.

## Why this is out of scope

Packaging the workflow for other people to install is adoption-shaped work,
and `docs/PRODUCT.md` is explicit: adoption by others is out of scope until
v2 is complete and stable. An issue justified by hypothetical external users
fails triage today.

The plan debate deferred PRD 2 story 14 and rescoped #94 to courier-only,
manual — which is the minimum that keeps a live run unblocked without
building a distributable artifact. The operator already has the workflow as
a local skill. What was cut is the packaging, versioning and consumer-facing
surface around it.

## Re-open trigger

Courier-only manual handling loses or garbles an impasse question in a live
run, **or** v2 completes and a second project needs the workflow.

## Prior requests

- #198: "Deferred: babysit-skill packaging (#70 story 14)"
