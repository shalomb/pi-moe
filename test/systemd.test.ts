import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("systemd --user Service Unit & Daemon Launcher (systemd/ & bin/moe-daemon)", () => {
  const servicePath = path.resolve("systemd/pi-moe.service");
  const daemonPath = path.resolve("bin/moe-daemon");

  it("pi-moe.service exists and contains correct systemd configuration directives", () => {
    assert.ok(fs.existsSync(servicePath), "pi-moe.service must exist");
    const content = fs.readFileSync(servicePath, "utf8");

    assert.match(content, /\[Unit\]/);
    assert.match(content, /Description=.*Moe.*Mixture-of-Experts Orchestrator/i);
    assert.match(content, /After=.*network-online\.target/);

    assert.match(content, /\[Service\]/);
    assert.match(content, /Type=simple/);
    assert.match(content, /OOMScoreAdjust=-500/);
    assert.match(content, /MemoryMax=1G/);
    assert.match(content, /Restart=always/);
    assert.match(content, /RestartSec=3/);
    assert.match(content, /Environment=.*PI_ROLE=moe/);
    assert.match(content, /Environment=.*MOE_ENABLED=1/);
    assert.match(content, /ExecStart=.*bin\/moe-daemon/);

    assert.match(content, /\[Install\]/);
    assert.match(content, /WantedBy=default\.target/);
  });

  it("bin/moe-daemon is executable and supports --dry-run / --check / --systemd", () => {
    assert.ok(fs.existsSync(daemonPath), "bin/moe-daemon must exist");
    const stat = fs.statSync(daemonPath);
    // Check executable bit
    assert.ok((stat.mode & 0o111) !== 0, "bin/moe-daemon must be executable");

    const dryRunOutput = execFileSync(daemonPath, ["--dry-run"], {
      encoding: "utf8",
    });

    assert.match(dryRunOutput, /moe-daemon: dry-run checks passed/i);
    assert.match(dryRunOutput, /PI_ROLE=moe/);
    assert.match(dryRunOutput, /tmux new-session/);
    assert.match(dryRunOutput, /-e .*src\/extension\.ts/);
    assert.match(dryRunOutput, /--remote/);

    const systemdDryOutput = execFileSync(daemonPath, ["--systemd", "--dry-run"], {
      encoding: "utf8",
    });
    assert.match(systemdDryOutput, /tmux new-session -d -s pi-moe/);

    const checkOutput = execFileSync(daemonPath, ["--check"], {
      encoding: "utf8",
    });
    assert.match(checkOutput, /moe-daemon: check passed/i);
  });
});
