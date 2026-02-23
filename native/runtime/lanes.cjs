"use strict";

// Command lanes.
//
// Two rules, and they interact:
//   1. Commands aimed at the same tab run one at a time, in order.
//   2. Commands that change browser-wide structure (creating, closing, focusing
//      tabs or windows, cookies, workspaces) must not run while a tab command is
//      using that tab - otherwise a close can land mid-click.
//
// So tab work takes a shared slot (many tabs in parallel), and a browser-wide
// command takes the writer slot (alone, after tab work drains). New tab work
// queues behind a waiting writer so it cannot starve.
//
// A lane is held until the caller releases it - normally when the extension
// answers - with a watchdog so a lost response cannot wedge the queue.

const LANE_TIMEOUT_MS = 45_000;
const WRITER_LANE = "browser";

const WRITER_TYPES = new Set([
  "tab.new",
  "tab.close",
  "tab.switch",
  "TAB_NEW",
  "tab.group",
  "tab.ungroup",
  "window.new",
  "WINDOW_CREATE",
  "window.close",
  "window.focus",
  "window.resize",
  "workspace.create",
  "workspace.close",
  "workspace.use",
  "cookie.set",
  "cookie.clear",
  "cookie.clearAll",
]);

// Per-lane FIFO
const tailByLane = new Map();
const waitingByLane = new Map();

// Reader/writer gate
let readers = 0;
let writersPending = 0;
let idleWaiters = [];
let writerQueue = Promise.resolve();

function laneFor(message) {
  if (!message || WRITER_TYPES.has(message.type)) {
    return WRITER_LANE;
  }
  if (message.tabId !== undefined && message.tabId !== null) {
    return `tab:${message.tabId}`;
  }
  // No tab yet: the extension resolves one. Key by stream so different streams
  // still run in parallel instead of everything collapsing onto one lane.
  return `stream:${message.workspace || "default"}`;
}

function activeLanes() {
  const lanes = new Set([...tailByLane.keys(), ...waitingByLane.keys()]);
  if (writersPending > 0) {
    lanes.add(WRITER_LANE);
  }
  return [...lanes].map((lane) => ({
    lane,
    waiting: waitingByLane.get(lane) || 0,
    writing: lane === WRITER_LANE && writersPending > 0,
  }));
}

function queuedCount() {
  let total = 0;
  for (const count of waitingByLane.values()) {
    total += count;
  }
  return total;
}

function notifyIdle() {
  if (readers === 0) {
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) {
      resolve();
    }
  }
}

// The barrier must be captured when the command arrives, before any await. If a
// reader captured it later, a writer queued after the reader could block it, and
// a writer that arrived first would let a later reader overtake it.
async function enterReader(barrier, counted) {
  await barrier;
  if (!counted) {
    readers += 1;
  }
  return () => {
    readers -= 1;
    notifyIdle();
  };
}

async function enterWriter(barrier) {
  let finish;
  writerQueue = new Promise((resolve) => {
    finish = resolve;
  });
  await barrier;
  if (readers > 0) {
    await new Promise((resolve) => idleWaiters.push(resolve));
  }
  return () => {
    writersPending -= 1;
    finish();
  };
}

function bump(lane) {
  waitingByLane.set(lane, (waitingByLane.get(lane) || 0) + 1);
}

function settle(lane) {
  const left = (waitingByLane.get(lane) || 1) - 1;
  if (left <= 0) {
    waitingByLane.delete(lane);
  } else {
    waitingByLane.set(lane, left);
  }
}

// Runs dispatch once this command's turn comes. Returns a release function that
// is idempotent, so calling it on response and again on timeout is safe.
async function submit(message, dispatch, options = {}) {
  const lane = laneFor(message);
  const isWriter = lane === WRITER_LANE;
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : LANE_TIMEOUT_MS;

  // Capture the write barrier synchronously, before this command waits anywhere.
  // A reader that arrived while no writer is waiting counts immediately, so a
  // writer queued after it must wait; a reader arriving behind a writer does not
  // count until the writer is done, or the two would wait on each other.
  const barrier = writerQueue;
  const counted = !isWriter && writersPending === 0;
  if (counted) {
    readers += 1;
  }
  if (isWriter) {
    writersPending += 1;
  }

  bump(lane);
  let releaseFifo;
  const fifo = new Promise((resolve) => {
    releaseFifo = resolve;
  });

  if (!isWriter) {
    const previous = tailByLane.get(lane) || Promise.resolve();
    const tail = previous.then(() => fifo);
    tailByLane.set(lane, tail);
    tail.then(() => {
      if (tailByLane.get(lane) === tail) {
        tailByLane.delete(lane);
      }
    });
    await previous;
  }

  let settled = false;
  const settleOnce = () => {
    if (!settled) {
      settled = true;
      settle(lane);
    }
  };

  let leaveGate = () => undefined;
  try {
    leaveGate = isWriter ? await enterWriter(barrier) : await enterReader(barrier, counted);
  } finally {
    settleOnce();
  }

  // A client that gave up before its turn must not run a browser action later.
  if (typeof options.isCancelled === "function" && options.isCancelled()) {
    leaveGate();
    releaseFifo();
    return () => undefined;
  }

  let released = false;
  const done = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(timer);
    leaveGate();
    releaseFifo();
  };

  const timer = setTimeout(done, timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  dispatch();
  return done;
}

function reset() {
  tailByLane.clear();
  waitingByLane.clear();
  readers = 0;
  writersPending = 0;
  idleWaiters = [];
  writerQueue = Promise.resolve();
}

module.exports = {
  LANE_TIMEOUT_MS,
  reset,
  WRITER_LANE,
  WRITER_TYPES,
  activeLanes,
  laneFor,
  queuedCount,
  submit,
};
