import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { artifactScenarios, stageArtifactInstallation } from "../support/artifact"

test("artifact selection preserves all outcomes by default and accepts an explicit ordered subset", () => {
  expect(artifactScenarios()).toEqual(["complete", "tool", "read", "budget", "timeout", "permission"])
  expect(artifactScenarios('["permission","read"]')).toEqual(["permission", "read"])
})

test.each(["", "null", "{}", "[]", '["tool","tool"]', '["unknown"]', '["read",1]'])(
  "artifact selection rejects invalid or empty evidence requests: %s",
  (selection) => {
    expect(() => artifactScenarios(selection)).toThrow("SYNERGY_TEST_ARTIFACT_SCENARIOS")
  },
)

test("artifact staging preserves an executable outside its source and rejects installation writes", async () => {
  const isolation = await createIsolatedTestEnv()
  const source = path.join(isolation.env.SYNERGY_TEST_ROOT!, "source")
  const binary = path.join(source, "bin", "synergy")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await Bun.write(binary, 'console.log(await Bun.file(new URL("../resource.txt", import.meta.url)).text())\n')
  await fs.chmod(binary, 0o755)
  await Bun.write(path.join(source, "resource.txt"), "retained resource")
  const staged = await stageArtifactInstallation(binary)
  try {
    expect(staged.binary.startsWith(source + path.sep)).toBe(false)
    await fs.rm(source, { recursive: true, force: true })
    const child = Bun.spawn([process.execPath, staged.binary], { stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("retained resource")
    if (process.platform !== "win32") {
      expect((await fs.stat(staged.binary)).mode & 0o222).toBe(0)
      expect((await fs.stat(path.dirname(staged.binary))).mode & 0o222).toBe(0)
      if (process.getuid?.() !== 0) await expect(fs.writeFile(staged.binary, "changed")).rejects.toThrow()
    }
  } finally {
    await staged.dispose()
    await isolation.dispose()
  }
  expect(await Bun.file(staged.binary).exists()).toBe(false)
})

test.skipIf(process.platform === "win32")(
  "artifact staging rejects links that escape the copied installation",
  async () => {
    const isolation = await createIsolatedTestEnv()
    try {
      const source = path.join(isolation.env.SYNERGY_TEST_ROOT!, "source")
      const binary = path.join(source, "bin", "synergy")
      const external = path.join(isolation.env.SYNERGY_TEST_ROOT!, "external.txt")
      await fs.mkdir(path.dirname(binary), { recursive: true })
      await Bun.write(binary, "fixture")
      await Bun.write(external, "unowned bytes")
      await fs.symlink(external, path.join(source, "external.txt"))
      await expect(stageArtifactInstallation(binary)).rejects.toThrow("symlink escapes")
      expect(await Bun.file(external).text()).toBe("unowned bytes")
    } finally {
      await isolation.dispose()
    }
  },
)
