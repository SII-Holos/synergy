import { expect, test } from "bun:test"
import path from "node:path"

test("the documented local acceptance help runs without starting a Runtime or asking for provider settings", async () => {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../script/acceptance.ts"), "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, error }).toEqual({ code: 0, error: "" })
  expect(output).toContain("plan --case")
  expect(output).toContain("resume --out")
  expect(output).toContain("fault-save-crash")
})
