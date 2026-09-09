import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { smokeRuntimeArtifact } from "../../../script/release/nodes/validate-local-artifacts"

test.skipIf(process.platform === "win32")("runtime smoke uses a copied installation and isolated home", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-smoke-fixture-"))
  try {
    await fs.mkdir(path.join(source, "bin"))
    await Bun.write(path.join(source, "resource.txt"), "packaged resource")
    const binary = path.join(source, "bin/synergy")
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
      const path = require("node:path");
      console.log(JSON.stringify({
        resource: await Bun.file(path.resolve(import.meta.dir, "../resource.txt")).text(),
        cwd: process.cwd(), home: process.env.SYNERGY_HOME, flag: process.argv[2],
      }));
    `,
    )
    await fs.chmod(binary, 0o755)
    const results = await smokeRuntimeArtifact(source, "full")
    expect(results.map((result) => result.flag)).toEqual([
      "--version",
      "__browser-playwright-runtime-check",
      "__embedding-runtime-check",
    ])
    for (const result of results) {
      const observed = JSON.parse(result.stdout)
      expect(observed.resource).toBe("packaged resource")
      expect(observed.cwd).not.toBe(source)
      expect(observed.home).toBe(path.join(path.dirname(observed.cwd), "home"))
      expect(observed.flag).toBe(result.flag)
      expect(await fs.stat(observed.cwd).catch(() => undefined)).toBeUndefined()
    }
  } finally {
    await fs.rm(source, { recursive: true, force: true })
  }
})
