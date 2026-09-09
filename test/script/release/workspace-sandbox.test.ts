import { expect, test } from "bun:test"
import { mkdtemp, rm, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { stageWorkspaceSandbox } from "../../../script/release/shared/build/workspace-sandbox"

test("module package embeds the validated helper digest and resolves its own copied asset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-helper-package-"))
  try {
    const assets = path.join(directory, "input")
    const output = path.join(directory, "dist")
    const target = { os: "linux", arch: "x64" as const }
    await expect(stageWorkspaceSandbox(output, target, assets)).rejects.toThrow("required")
    const bytes = Buffer.alloc(2048)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    bytes.writeUInt16LE(62, 18)
    await Bun.write(path.join(assets, "linux-x64/synergy-sandbox-linux"), bytes)
    await stageWorkspaceSandbox(output, target, assets)
    const module = await import(pathToFileURL(path.join(output, "helper-assets.js")).href)
    const helper = module.packagedSandboxHelper()
    expect(helper.platform).toBe("linux")
    expect(helper.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(helper.path).toBe(await realpath(path.join(output, "assets/synergy-sandbox-linux")))
    expect(Buffer.from(await Bun.file(helper.path).arrayBuffer())).toEqual(bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
