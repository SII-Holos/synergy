import { expect, test } from "bun:test"
import path from "node:path"
import { stat } from "node:fs/promises"

const sdk = path.resolve(import.meta.dir, "../../../packages/sdk/js")

async function generatedFiles() {
  const files = [...new Bun.Glob("src/gen/**/*.ts").scanSync({ cwd: sdk })].sort()
  return Promise.all(files.map(async (file) => ({ file, modified: (await stat(path.join(sdk, file))).mtimeMs })))
}

test("SDK validation build preserves generated source while emitting the published client", async () => {
  const before = await generatedFiles()
  expect(before.length).toBeGreaterThan(0)
  const build = Bun.spawn([process.execPath, "run", "build", "--compile-only"], {
    cwd: sdk,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, output, errors] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  expect({ exit, output: exit ? output : "", errors: exit ? errors : "" }).toEqual({ exit: 0, output: "", errors: "" })
  expect(await generatedFiles()).toEqual(before)
  expect(await Bun.file(path.join(sdk, "dist/index.js")).exists()).toBe(true)
  expect(await Bun.file(path.join(sdk, "dist/gen/sdk.gen.d.ts")).exists()).toBe(true)
}, 30_000)
