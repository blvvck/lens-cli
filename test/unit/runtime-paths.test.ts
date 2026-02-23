/// <reference types="node" />

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as runtimePaths from "../../native/runtime-paths.cjs";

describe("runtime paths", () => {
  it("uses a Windows named pipe for the browser endpoint", () => {
    expect(runtimePaths.getBrowserEndpoint("win32")).toBe("\\\\.\\pipe\\lens.sock");
  });

  it("uses a Unix socket path for the browser endpoint on macOS/Linux", () => {
    expect(runtimePaths.getBrowserEndpoint("darwin")).toBe(path.join(os.tmpdir(), "lens.sock"));
    expect(runtimePaths.getBrowserEndpoint("linux")).toBe(path.join(os.tmpdir(), "lens.sock"));
  });

  it("uses profile-specific endpoints on every platform", () => {
    expect(runtimePaths.getProfileEndpoint("work", "win32")).toBe("\\\\.\\pipe\\lens-work.sock");
    expect(runtimePaths.getProfileEndpoint("work", "linux")).toBe(
      path.join(os.tmpdir(), "lens-work.sock"),
    );
  });

  it("stores runtime metadata under a real directory on Windows", () => {
    expect(runtimePaths.getRuntimeDir("win32")).toBe(path.join(os.tmpdir(), "lens"));
    expect(runtimePaths.getHeadlessPidPath("win32")).toBe(
      path.join(os.tmpdir(), "lens", "lens-headless.pid"),
    );
  });

  it("keeps Unix pid files in the temp root for backwards compatibility", () => {
    expect(runtimePaths.getHeadlessPidPath("linux")).toBe(path.join(os.tmpdir(), "lens-headless.pid"));
  });
});

describe("browser discovery", () => {
  it("prefers the first existing Windows browser path", () => {
    const candidate = runtimePaths.findChromiumBinary({
      platform: "win32",
      env: {},
      configPath: null,
      exists: (value: string) =>
        value === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      lookupOnPath: () => null,
    });

    expect(candidate).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("falls back to PATH lookup when well-known Windows locations are missing", () => {
    const candidate = runtimePaths.findChromiumBinary({
      platform: "win32",
      env: {},
      configPath: null,
      exists: () => false,
      lookupOnPath: (commands: string[]) => {
        expect(commands).toContain("msedge.exe");
        return "C:\\Users\\HP\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe";
      },
    });

    expect(candidate).toBe(
      "C:\\Users\\HP\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  });
});
