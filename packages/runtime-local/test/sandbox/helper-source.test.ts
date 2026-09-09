import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { registerSandboxHelper } from "../../src/sandbox/helper-source"
import { getLinuxHelperInfo } from "../../src/sandbox/linux"

test("host-provided helper uses the packaged digest and rejects replacement bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-helper-source-"))
  try {
    const file = path.join(directory, "helper")
    const contents = Buffer.alloc(2048, 1)
    await Bun.write(file, contents)
    await chmod(file, 0o755)
    const asset = {
      platform: "linux" as const,
      path: file,
      sha256: createHash("sha256").update(contents).digest("hex"),
    }
    registerSandboxHelper(asset)
    registerSandboxHelper(asset)
    expect(getLinuxHelperInfo()).toEqual({ path: file, verified: true })
    await Bun.write(file, Buffer.alloc(2048, 2))
    expect(getLinuxHelperInfo()).toBeNull()
    expect(() => registerSandboxHelper({ ...asset, sha256: "a".repeat(64) })).toThrow("already registered")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
