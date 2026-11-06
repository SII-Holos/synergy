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

test("artifact staging preserves installed modes when materializing an isolated runtime", async () => {
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
    const runtime = path.join(isolation.env.SYNERGY_TEST_ROOT!, "runtime")
    await fs.cp(path.dirname(path.dirname(staged.binary)), runtime, { recursive: true })
    await Bun.write(path.join(runtime, "bin", "generation.json"), "{}")
    if (process.platform !== "win32") {
      expect((await fs.stat(staged.binary)).mode & 0o777).toBe(0o755)
      expect((await fs.stat(path.dirname(staged.binary))).mode & 0o200).toBe(0o200)
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

test("artifact staging rejects changes to the shared installation", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const binary = path.join(isolation.env.SYNERGY_TEST_ROOT!, "source", "bin", "synergy")
    await Bun.write(binary, "original executable")
    const staged = await stageArtifactInstallation(binary)
    await fs.chmod(staged.binary, 0o644)
    await Bun.write(staged.binary, "modified executable")
    await expect(staged.dispose()).rejects.toThrow("Shared artifact installation changed")
    expect(await Bun.file(staged.binary).exists()).toBe(false)
  } finally {
    await isolation.dispose()
  }
})
