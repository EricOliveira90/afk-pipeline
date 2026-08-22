import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseStatusWebArgs,
  startStatusWebServer,
  type StatusWebHandle,
} from "./status-web.js";

const handles: StatusWebHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "afk-status-web-"));
  const runDir = join(root, ".afk", "logs", "demo", "run-20260822-020000");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      { type: "header", version: 1, ts: "2026-08-22T02:00:00.000Z" },
      {
        type: "run-started",
        provider: "stub",
        runSlug: "demo-stub",
        ts: "2026-08-22T02:00:00.100Z",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return { root, runDir };
}

describe("status web server", () => {
  it("validates web-only flags", () => {
    expect(() => parseStatusWebArgs(["--web", "--json"], ".")).toThrow(
      "--web cannot be combined with --json",
    );
    expect(() => parseStatusWebArgs(["--web", "--port", "no"], ".")).toThrow(
      "--port must be an integer",
    );
    expect(parseStatusWebArgs(["--web", "--no-open"], ".")).toMatchObject({
      port: 0,
      open: false,
    });
  });

  it("serves only the dashboard and live status with no-store headers", async () => {
    const { root, runDir } = fixture();
    const handle = await startStatusWebServer(root, {
      runDir,
      port: 0,
      open: false,
    });
    handles.push(handle);

    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Expanded stage matrix");

    const status = await fetch(`${handle.url}/api/status`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const body = (await status.json()) as {
      pipeline: { run: { slug?: string } };
    };
    expect(body.pipeline.run.slug).toBe("demo-stub");

    expect((await fetch(`${handle.url}/missing`)).status).toBe(404);
    expect(
      (await fetch(`${handle.url}/api/status`, { method: "POST" })).status,
    ).toBe(405);
  });
});
