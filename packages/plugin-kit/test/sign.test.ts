import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { buildPluginProject } from "../src/commands/build"
import { packPluginProject } from "../src/commands/pack"
import { extractTarballText } from "../src/lib/tarball"
import { sha256File } from "../src/lib/crypto"
import { createFixtureProject, minimalPluginSource, writeMinimalPlugin } from "./fixtures"

const originalTestHome = process.env.SYNERGY_TEST_HOME
const testHome = fs.mkdtempSync(path.join(import.meta.dir, "sign-home-"))

beforeAll(() => {
  process.env.SYNERGY_TEST_HOME = testHome
})

afterAll(() => {
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome
  fs.rmSync(testHome, { recursive: true, force: true })
})

async function builtTarball(source: string, id: string) {
  const project = createFixtureProject("sign-fixture-")
  writeMinimalPlugin(project, source, id)
  expect(await buildPluginProject(project.root)).toBe(true)
  const tarballPath = packPluginProject(project.root)
  return { project, tarballPath }
}

describe("signPluginTarball", () => {
  test("signs a built tarball with a generated ed25519 key", async () => {
    const { project, tarballPath } = await builtTarball(minimalPluginSource("sign-fixture"), "sign-fixture")
    try {
      const { signPluginTarball } = await import("../src/commands/sign")
      const sigPath = await signPluginTarball(tarballPath)
      expect(sigPath).toBe(`${tarballPath}.sig`)
      expect(fs.existsSync(sigPath)).toBe(true)

      const signature = JSON.parse(fs.readFileSync(sigPath, "utf8"))
      expect(signature.signatureVersion).toBe(1)
      expect(signature.pluginId).toBe("sign-fixture")
      expect(signature.version).toBe("1.0.0")
      expect(signature.algorithm).toBe("ed25519")
      expect(signature.signer).toMatch(/^[0-9a-f]{64}$/)
      expect(signature.signature).toMatch(/^[0-9a-f]{128}$/)

      const manifest = PluginManifest.parse(JSON.parse(extractTarballText(tarballPath, "plugin.json") ?? "{}"))
      expect(signature.payload.tarballHash).toBe(sha256File(tarballPath))
      expect(signature.payload.manifestHash).toBe(computeManifestHash(manifest))
      expect(signature.payload.permissionsHash).toBe(computePermissionsHash(manifest))
    } finally {
      project.cleanup()
    }
  })

  test("reuses the persisted signing key across signatures", async () => {
    const { project, tarballPath } = await builtTarball(minimalPluginSource("sign-reuse"), "sign-reuse")
    try {
      const { signPluginTarball } = await import("../src/commands/sign")
      await signPluginTarball(tarballPath)
      const first = JSON.parse(fs.readFileSync(`${tarballPath}.sig`, "utf8"))

      await signPluginTarball(tarballPath)
      const second = JSON.parse(fs.readFileSync(`${tarballPath}.sig`, "utf8"))
      expect(second.signer).toBe(first.signer)
    } finally {
      project.cleanup()
    }
  })

  test("rejects missing tarballs", async () => {
    const { signPluginTarball } = await import("../src/commands/sign")
    const missing = path.join(import.meta.dir, "sign-missing-", "missing.tgz")
    await expect(signPluginTarball(missing)).rejects.toThrow(/Tarball not found/)
  })

  test("rejects tarballs without a manifest or permissions summary", async () => {
    const project = createFixtureProject("sign-incomplete-")
    try {
      const staging = path.join(project.root, "payload")
      fs.mkdirSync(staging)
      fs.writeFileSync(path.join(staging, "plugin.json"), "{}")
      const tarball = path.join(project.root, "incomplete.tgz")
      const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", staging, "."])
      expect(packed.exitCode).toBe(0)

      const { signPluginTarball } = await import("../src/commands/sign")
      await expect(signPluginTarball(tarball)).rejects.toThrow(/Failed to parse plugin.json/)
    } finally {
      project.cleanup()
    }
  })
})

describe("PluginSignCommand", () => {
  test("signs a tarball and reports failures through the exit code", async () => {
    const { PluginSignCommand } = await import("../src/commands/sign")
    const { restoreExitCode } = await import("./fixtures")

    const previousExitCode = process.exitCode
    try {
      const missing = path.join(import.meta.dir, "sign-command-missing-", "missing.tgz")
      await PluginSignCommand.handler!({ tarball: missing, stdout: false } as never)
      expect(process.exitCode).toBe(1)
    } finally {
      restoreExitCode(previousExitCode)
    }
  })
})

describe("signing key storage", () => {
  test("writes the generated key with restricted permissions", async () => {
    const { project, tarballPath } = await builtTarball(minimalPluginSource("sign-keyfile"), "sign-keyfile")
    try {
      const { signPluginTarball } = await import("../src/commands/sign")
      const { SIGNING_KEY_FILE } = await import("../src/lib/paths")
      fs.rmSync(SIGNING_KEY_FILE, { force: true })
      await signPluginTarball(tarballPath)
      expect(fs.existsSync(SIGNING_KEY_FILE)).toBe(true)
      const mode = fs.statSync(SIGNING_KEY_FILE).mode & 0o777
      expect(mode).toBe(0o600)
      const key = JSON.parse(fs.readFileSync(SIGNING_KEY_FILE, "utf8"))
      expect(key.publicKey).toMatch(/^[0-9a-f]{64}$/)
      expect(key.privateKey).toBeTruthy()
    } finally {
      project.cleanup()
    }
  })
})
