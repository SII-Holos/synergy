import { expect, test } from "bun:test"
import path from "path"

const fixture = path.join(import.meta.dir, "fixtures", "catalog-resilient-load.ts")

test("ProviderCatalog module import does not crash when ModelsDev module export is missing", async () => {
  const child = Bun.spawn([process.execPath, "run", fixture], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`catalog resilient load fixture failed (${exitCode}): ${stderr}`)
  expect(stdout.trim()).toBe("OK")
})
