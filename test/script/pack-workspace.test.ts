import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { packWorkspace } from "../../script/pack-workspace"

test("programmatic workspace packing keeps relative output outside its temporary staging directory", async () => {
  const artifacts = path.resolve(import.meta.dir, "../../.artifacts")
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(path.join(artifacts, "relative-pack-"))
  const output = path.join(root, "archives")
  try {
    const packed = await packWorkspace("packages/secret-detection", path.relative(process.cwd(), output))
    expect(path.isAbsolute(packed.entry)).toBe(true)
    expect(path.dirname(packed.entry)).toBe(output)
    expect(await Bun.file(packed.entry).exists()).toBe(true)
    const read = Bun.spawn(["tar", "-xOf", packed.entry, "package/package.json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, contents, error] = await Promise.all([
      read.exited,
      new Response(read.stdout).text(),
      new Response(read.stderr).text(),
    ])
    expect(code, error).toBe(0)
    const manifest = JSON.parse(contents)
    expect(manifest.name).toBe("@ericsanchezok/synergy-secret-detection")
    expect(packed.archives[manifest.name]).toBe(packed.entry)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
