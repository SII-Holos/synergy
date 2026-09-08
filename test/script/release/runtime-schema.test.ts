import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { check, resolveConfig } from "prettier"
import { REPO_ROOT } from "../../../script/release/shared/packages"

for (const profile of ["core", "full"] as const) {
  test(`${profile} build schema preserves its contract and repository formatting`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-build-schema-"))
    try {
      const owner = profile === "core" ? "cli" : "product-runtime"
      const canonical = path.join(REPO_ROOT, "packages", owner, "schema/config.schema.json")
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {generateSchema} from ${JSON.stringify(path.join(REPO_ROOT, "script/release/shared/build-runtime.ts"))}; await generateSchema(${JSON.stringify(directory)}, ${JSON.stringify(profile)})`,
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, SYNERGY_HOME: path.join(directory, "home") },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(exit).toBe(0)
      const source = await Bun.file(path.join(directory, "schema/config.schema.json")).text()
      expect(JSON.parse(source)).toEqual(await Bun.file(canonical).json())
      expect(await check(source, { ...(await resolveConfig(canonical)), filepath: canonical })).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
