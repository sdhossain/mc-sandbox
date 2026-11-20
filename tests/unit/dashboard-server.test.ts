import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Lab } from "../../src/lab/lab.ts";
import { DashboardServer } from "../../src/observability/dashboard/dashboard-server.ts";
import { EventBus } from "../../src/observability/event-bus.ts";

/** A different port per test, so no test reuses a pooled connection to an earlier test's server. */
let nextPort = 28_787;

/** The parts of a Lab the dashboard reads, with no agents. */
function stubLab(bus: EventBus): Lab {
  return {
    bus,
    agents: [],
    agent: () => undefined,
    config: { runsDir: mkdtempSync(join(tmpdir(), "mclab-dashboard-")), owners: ["Owner"] },
  } as unknown as Lab;
}

describe("DashboardServer", () => {
  let dashboard: DashboardServer | undefined;
  afterEach(async () => {
    await dashboard?.close();
  });

  it("serves the page, its script, and the run list", async () => {
    dashboard = new DashboardServer(stubLab(new EventBus()), { host: "127.0.0.1", port: nextPort++ });
    await dashboard.listen();
    const page = await fetch(dashboard.url);
    expect(await page.text()).toContain("<title>Harness Lab</title>");
    const script = await fetch(`${dashboard.url}app.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${dashboard.url}api/runs`)).json()).toEqual([]);
  });

  it("streams events, replaying earlier ones to a new page", async () => {
    const bus = new EventBus();
    dashboard = new DashboardServer(stubLab(bus), { host: "127.0.0.1", port: nextPort++ });
    await dashboard.listen();
    bus.publish({ agent: "Sol", runId: "run-1" }, "log", { level: "info", message: "before the page opened" });

    const response = await fetch(`${dashboard.url}api/events`);
    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    bus.publish({ agent: "Sol", runId: "run-1" }, "log", { level: "info", message: "after the page opened" });
    let received = "";
    while (reader !== undefined && !received.includes("after the page opened")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      received += new TextDecoder().decode(value);
    }
    await reader?.cancel();
    expect(received).toContain("before the page opened");
    expect(received).toContain("after the page opened");
  });

  it("rejects messages to unknown agents", async () => {
    dashboard = new DashboardServer(stubLab(new EventBus()), { host: "127.0.0.1", port: nextPort++ });
    await dashboard.listen();
    const response = await fetch(`${dashboard.url}api/agents/Nobody/message`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(response.status).toBe(404);
  });
});
