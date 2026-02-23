import { beforeEach } from "vitest";
// @ts-expect-error - CommonJS module without type definitions
import * as lanes from "../../../native/runtime/lanes.cjs";

beforeEach(() => {
  lanes.reset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("command lanes", () => {
  it("puts tab commands on their own lane", () => {
    expect(lanes.laneFor({ type: "page.click", tabId: 7 })).toBe("tab:7");
    expect(lanes.laneFor({ type: "page.inspect", tabId: 9 })).toBe("tab:9");
  });

  it("keys commands without a tab by stream, so streams stay parallel", () => {
    expect(lanes.laneFor({ type: "page.inspect" })).toBe("stream:default");
    expect(lanes.laneFor({ type: "page.inspect", workspace: "checkout-flow" })).toBe(
      "stream:checkout-flow",
    );
  });

  it("puts browser-wide mutations on the writer lane", () => {
    expect(lanes.laneFor({ type: "window.new" })).toBe("browser");
    expect(lanes.laneFor({ type: "workspace.create" })).toBe("browser");
    expect(lanes.laneFor({ type: "workspace.use" })).toBe("browser");
  });

  it("holds the second command on a lane until the first answers", async () => {
    const order: string[] = [];
    const first = lanes.submit({ type: "page.click", tabId: 1 }, () => order.push("first"));
    const second = lanes.submit({ type: "page.click", tabId: 1 }, () => order.push("second"));

    await tick();
    expect(order).toEqual(["first"]);

    (await first)();
    await tick();
    expect(order).toEqual(["first", "second"]);

    (await second)();
  });

  it("lets different tabs run in parallel", async () => {
    const order: string[] = [];
    const a = lanes.submit({ type: "page.click", tabId: 2 }, () => order.push("tab-2"));
    const b = lanes.submit({ type: "page.click", tabId: 3 }, () => order.push("tab-3"));

    await tick();
    expect(order.sort()).toEqual(["tab-2", "tab-3"]);

    (await a)();
    (await b)();
  });

  it("makes a browser-wide command wait for tab work to finish", async () => {
    const order: string[] = [];
    const tab = lanes.submit({ type: "page.click", tabId: 4 }, () => order.push("click"));
    const close = lanes.submit({ type: "tab.close", tabId: 4 }, () => order.push("close-tab"));

    await tick();
    expect(order).toEqual(["click"]);

    (await tab)();
    await tick();
    expect(order).toEqual(["click", "close-tab"]);

    (await close)();
  });

  it("holds new tab work behind a writer that is already waiting", async () => {
    const order: string[] = [];
    const writable = lanes.submit({ type: "page.inspect", tabId: 5 }, () => order.push("read"));
    await tick();
    (await writable)();

    const writer = lanes.submit({ type: "window.new" }, () => order.push("window"));
    const reader = lanes.submit({ type: "page.inspect", tabId: 6 }, () => order.push("read-2"));

    await tick();
    expect(order).toEqual(["read", "window"]);

    (await writer)();
    await tick();
    expect(order).toEqual(["read", "window", "read-2"]);

    (await reader)();
  });

  it("reports how many commands are waiting", async () => {
    const order: string[] = [];
    const first = lanes.submit({ type: "page.click", tabId: 7 }, () => order.push("first"));
    const second = lanes.submit({ type: "page.click", tabId: 7 }, () => order.push("second"));

    await tick();
    expect(lanes.queuedCount()).toBeGreaterThan(0);
    expect(lanes.activeLanes().some((entry: { lane: string }) => entry.lane === "tab:7")).toBe(
      true,
    );

    (await first)();
    await tick();
    (await second)();
  });

  it("frees a lane on the watchdog when no answer arrives", async () => {
    const order: string[] = [];
    lanes.submit({ type: "page.click", tabId: 8 }, () => order.push("stuck"), { timeoutMs: 5 });
    lanes.submit({ type: "page.click", tabId: 8 }, () => order.push("after"));

    await tick();
    expect(order).toEqual(["stuck"]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["stuck", "after"]);
  });

  it("treats a repeated release as a no-op", async () => {
    const release = await lanes.submit({ type: "page.click", tabId: 9 }, () => undefined);
    expect(() => {
      release();
      release();
    }).not.toThrow();
  });
});
