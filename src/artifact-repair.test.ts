import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEGOTIATION_ARTIFACT_REPAIRS,
  decideNegotiationArtifactRepair,
  formatNegotiationArtifactRepairInstruction,
} from "./artifact-repair.js";

describe("negotiation artifact repair policy", () => {
  it("hands back the exact validation error once, then stops", () => {
    // The three PRD 072 refusals (#188 defect 1), each terminal on `7e3fba4c`.
    const defects = [
      "contract-review.json findings[2] finding severity must be BLOCKING or ADVISORY",
      "contract-review.json fresh finding F-03 revisionCitation after does not match current acceptance-manifest.json",
      "contract-response.json must declare round 2",
    ];
    for (const defect of defects) {
      const first = decideNegotiationArtifactRepair({
        artifact: "contract-review.json",
        defect,
        artifactWritten: true,
        repairsUsed: 0,
      });
      expect(first.action).toBe("repair");
      // Verbatim, not paraphrased: the error text is the whole value of the
      // pass, and a summary of it is what the agent already failed to infer.
      expect(first.action === "repair" && first.instruction).toContain(defect);
    }

    const spent = decideNegotiationArtifactRepair({
      artifact: "contract-review.json",
      defect: defects[0]!,
      artifactWritten: true,
      repairsUsed: DEFAULT_NEGOTIATION_ARTIFACT_REPAIRS,
    });
    expect(spent).toEqual({
      action: "stop",
      reason:
        "the 1 repair pass(es) allowed for contract-review.json in this round were already spent",
    });
  });

  it("refuses to spend a dispatch on a refusal with no stated defect", () => {
    expect(
      decideNegotiationArtifactRepair({
        artifact: "contract-response.json",
        defect: "   ",
        artifactWritten: true,
        repairsUsed: 0,
      }),
    ).toEqual({
      action: "stop",
      reason:
        "the contract-response.json refusal carried no validation error to repair",
    });
  });

  it("leaves a missing artifact terminal, as ADR 0017 already had it", () => {
    // An agent that wrote nothing did not get a field wrong; the retry policy
    // has already had its say, and there is no validation error to hand back.
    expect(
      decideNegotiationArtifactRepair({
        artifact: "contract-review.json",
        defect:
          "C:/repo/specs/slices/01/contract-review.json is missing",
        artifactWritten: false,
        repairsUsed: 0,
      }),
    ).toEqual({
      action: "stop",
      reason:
        "contract-review.json was never written, so there is no artifact to repair",
    });
  });

  it("honors a caller-supplied repair budget", () => {
    const second = decideNegotiationArtifactRepair({
      artifact: "contract-review.json",
      defect: "contract-review.json must declare version 2",
      artifactWritten: true,
      repairsUsed: 1,
      repairLimit: 2,
    });
    expect(second.action).toBe("repair");
  });

  it("tells the agent the round did not advance", () => {
    const instruction = formatNegotiationArtifactRepairInstruction({
      artifact: "contract-response.json",
      defect: "contract-response.json must declare round 2",
    });
    expect(instruction).toContain("repair pass, not a new round");
    expect(instruction).toContain("contract-response.json");
    expect(instruction).toContain("change nothing");
  });
});
