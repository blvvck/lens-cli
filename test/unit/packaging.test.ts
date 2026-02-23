import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function packAndExtract(): { workspace: string; packageDir: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lens-pack-"));
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", workspace], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();

  if (!tarball) {
    throw new Error("npm pack did not produce a tarball");
  }

  execFileSync("tar", ["-xzf", path.join(workspace, tarball), "-C", workspace]);

  const packageDir = path.join(workspace, "node_modules", "@lens-cli", "lens");
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.renameSync(path.join(workspace, "package"), packageDir);

  return { workspace, packageDir };
}

describe("packaged exports", () => {
  const { workspace, packageDir } = packAndExtract();
  const requireFromConsumer = createRequire(path.join(workspace, "consumer.cjs"));

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("ships the client and the recipe modules", () => {
    expect(fs.existsSync(path.join(packageDir, "native", "client.cjs"))).toBe(true);
  });

  it("ships isolated classic content scripts", () => {
    for (const relativePath of ["content/tree/index.js", "content/visual-indicator.js"]) {
      const contentScript = fs.readFileSync(path.join(packageDir, "dist", relativePath), "utf8");

      expect(contentScript).not.toMatch(/^\s*(?:import|export)(?:\s|[{*])/m);
      expect(contentScript).toMatch(/^\(function\(\)\{/);
    }
  });

  it("resolves the client from the package and from the subpath", () => {
    const fromRoot = requireFromConsumer("@lens-cli/lens");
    const fromSubpath = requireFromConsumer("@lens-cli/lens/client");

    expect(typeof fromRoot.sendTool).toBe("function");
    expect(typeof fromRoot.resolveSocketPath).toBe("function");
    expect(fromSubpath).toBe(fromRoot);
  });

  it("keeps internal modules private", () => {
    expect(() => requireFromConsumer("@lens-cli/lens/native/figma/operations.cjs")).toThrowError(
      /is not defined by "exports"/,
    );
  });
});
