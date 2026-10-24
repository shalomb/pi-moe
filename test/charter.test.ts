import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MOE_HIGH_AGENCY_CHARTER, assessActionRisk } from "../src/charter.ts";

describe("High-Agency & Risk-Calibrated Autonomy Charter (src/charter.ts)", () => {
  it("exports MOE_HIGH_AGENCY_CHARTER with 3-tier policy and high-agency directives", () => {
    assert.ok(MOE_HIGH_AGENCY_CHARTER);
    assert.match(MOE_HIGH_AGENCY_CHARTER, /Green Zone/i);
    assert.match(MOE_HIGH_AGENCY_CHARTER, /Amber Zone/i);
    assert.match(MOE_HIGH_AGENCY_CHARTER, /Red Zone/i);
    assert.match(MOE_HIGH_AGENCY_CHARTER, /high-agency DWIM operator/i);
    assert.match(MOE_HIGH_AGENCY_CHARTER, /Never ask/i);
  });

  it("assessActionRisk correctly classifies actions into green, amber, or red", () => {
    // Green Zone: Read, test, local shadow tasks, XDG notes, isolated delegates, branch creation
    assert.equal(assessActionRisk("read file foo.ts"), "green");
    assert.equal(assessActionRisk("run npm test"), "green");
    assert.equal(assessActionRisk("todo add 'fix bug'"), "green");
    assert.equal(assessActionRisk("ob-cli --mode=memory inbox.md --capture 'note'"), "green");
    assert.equal(assessActionRisk("moe_delegate builder"), "green");
    assert.equal(assessActionRisk("git checkout -b feature/test"), "green");
    assert.equal(assessActionRisk("git commit -m 'feat: add cli'"), "green");

    // Amber Zone: Vault updates, skill-register changes, restarting scopes, pushing feature branch
    assert.equal(assessActionRisk("ob-cli --mode=obsidian Incoming.md --capture 'note'"), "amber");
    assert.equal(assessActionRisk("update skill-register.json"), "amber");
    assert.equal(assessActionRisk("systemctl --user restart pi-moe"), "amber");
    assert.equal(assessActionRisk("git push origin feature/test"), "amber");

    // Red Zone: Force push, delete repos/branches, terraform apply / prod deploys, external messages
    assert.equal(assessActionRisk("git push --force origin main"), "red");
    assert.equal(assessActionRisk("rm -rf repo/"), "red");
    assert.equal(assessActionRisk("git branch -D feature/test"), "red");
    assert.equal(assessActionRisk("terraform apply"), "red");
    assert.equal(assessActionRisk("send email to team"), "red");
    assert.equal(assessActionRisk("disable security guardrails"), "red");
  });
});
