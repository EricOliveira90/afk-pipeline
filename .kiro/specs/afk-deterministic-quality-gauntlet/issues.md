| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #49 | Block slice QA on orchestrator-owned base gates | AFK | — | US-1–11, US-16–17 |
| 02 | #50 | Reuse passing gates only for an unchanged candidate | AFK | #49 | US-2, US-8, US-55, US-60, US-64 |
| 03 | #51 | Approve generated behavior with a strict read-only evaluator | AFK | #49 | US-18–24, US-40–42, US-65–66 |
| 04 | #52 | Reject changes outside the locked slice scope | AFK | #49 | US-25–29 |
| 05 | #53 | Prove planned behavior with executable acceptance evidence | AFK | #49, #51 | US-12–15, US-40–42 |
| 06 | #54 | Run focused generator-evaluator repair contexts | AFK | #51, #53 | US-19–20, US-55–56, US-69–72 |
| 07 | #55 | Clean one approved candidate and re-prove behavior | AFK | #52, #53, #54 | US-30–33, US-43–44, US-65, US-67–68 |
| 08 | #56 | Repair cleaner failures through bounded fresh rounds | AFK | #55 | US-32–33, US-55–56, US-59–60, US-67, US-71 |
| 09 | #57 | Harden one approved candidate with mutation evidence | AFK | #55 | US-34–39, US-67–69 |
| 10 | #58 | Repair surviving mutants through bounded fresh rounds | AFK | #57 | US-34–39, US-55–56, US-59–60, US-71 |
| 11 | #59 | Make aggregate guardians strict and read-only | AFK | #51, #53 | US-43, US-45–46, US-51–55, US-59–60 |
| 12 | #60 | Remediate guardian blockers and rerun ship gates | AFK | #50, #56, #58, #59 | US-47–52, US-53–56, US-59–60, US-69–72 |
