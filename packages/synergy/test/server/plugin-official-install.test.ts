import { describe, expect, test } from "bun:test"
import { subtle } from "node:crypto"
import path from "path"
import fs from "fs"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { Config } from "../../src/config/config"
import { PLUGIN_MARKETPLACE_DEFAULTS } from "../../src/config/schema"
import { PluginMarketplaceRegistry } from "../../src/plugin/marketplace-registry"
import { computeManifestHash, computePermissionsHash } from "../../src/plugin/consent/approval-store"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { sha256File } from "../../src/util/crypto"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const PLUGIN_ID = "official-test-plugin"
const PLUGIN_VERSION = "1.0.0"
const REGISTRY_URL = "https://registry.test/synergy/plugins/registry.json"

async function generateKeyPair() {
  const key = (await subtle.generateKey("Ed25519" as any, true, ["sign", "verify"])) as CryptoKeyPair
  const privateRaw = await subtle.exportKey("pkcs8", key.privateKey)
  const publicRaw = await subtle.exportKey("raw", key.publicKey)
  return {
    privateKey: Buffer.from(privateRaw as ArrayBuffer).toString("hex"),
    publicKey: Buffer.from(publicRaw as ArrayBuffer).toString("hex"),
  }
}

function buildManifest(displayName: string): PluginManifestType {
  return PluginManifest.parse({
    manifestVersion: 1,
    apiVersion: "3.0",
    id: PLUGIN_ID,
    name: displayName,
    version: PLUGIN_VERSION,
    description: "Official registry install test plugin",
    capabilities: [],
    contributions: [{ kind: "skill", id: "greeting", skill: { name: "greeting" } }],
    artifacts: { generation: "test-generation" },
  }) as PluginManifestType
}

async function buildSignedArtifact(displayName: string) {
  const key = await generateKeyPair()
  const manifest = buildManifest(displayName)
  const manifestHash = computeManifestHash(manifest)
  const permissionsHash = computePermissionsHash(manifest, [])

  const dir = fs.mkdtempSync(path.join(Global.Path.cache, "official-install-fixture-"))
  const staging = path.join(dir, "payload")
  fs.mkdirSync(staging, { recursive: true })
  await Bun.write(path.join(staging, "plugin.json"), JSON.stringify(manifest, null, 2))
  await Bun.write(path.join(staging, "integrity.json"), JSON.stringify({ files: {} }))
  await Bun.write(
    path.join(staging, "permissions.summary.json"),
    JSON.stringify({ pluginId: PLUGIN_ID, version: PLUGIN_VERSION, permissions: [] }),
  )
  const tarballPath = path.join(dir, `${PLUGIN_ID}-${PLUGIN_VERSION}.synergy-plugin.tgz`)
  const packed = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", staging, "."], { stdout: "pipe", stderr: "pipe" })
  if (packed.exitCode !== 0) throw new Error(`Failed to pack fixture tarball: ${packed.stderr}`)

  const tarballHash = sha256File(tarballPath)
  const payload = { tarballHash, manifestHash, permissionsHash }
  const privateKey = await subtle.importKey("pkcs8", Buffer.from(key.privateKey, "hex"), "Ed25519" as any, false, [
    "sign",
  ])
  const signature = await subtle.sign("Ed25519" as any, privateKey, new TextEncoder().encode(JSON.stringify(payload)))
  const metadata = {
    signatureVersion: 1,
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    algorithm: "ed25519",
    signer: key.publicKey,
    signature: Buffer.from(signature as ArrayBuffer).toString("hex"),
    signedAt: Date.now(),
    payload,
  }
  await Bun.write(`${tarballPath}.sig`, JSON.stringify(metadata, null, 2))

  return {
    dir,
    tarballPath,
    tarballHash,
    manifestHash,
    permissionsHash,
    signer: key.publicKey,
  }
}

async function writeOfficialCache(artifact: Awaited<ReturnType<typeof buildSignedArtifact>>) {
  const paths = PluginMarketplaceRegistry.cachePaths(REGISTRY_URL)
  fs.mkdirSync(paths.entries, { recursive: true })
  const publishedAt = new Date("2026-07-20T00:00:00.000Z").toISOString()
  await Bun.write(
    paths.registry,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: publishedAt,
      plugins: [
        {
          id: PLUGIN_ID,
          name: PLUGIN_ID,
          description: "Official registry install test plugin",
          repo: "https://github.com/SII-Holos/official-test-plugin",
          entry: "plugins/official-test-plugin.json",
          author: { name: "SII Holos" },
          verified: true,
          official: true,
          keywords: ["synergy-plugin", "official"],
          latestVersion: PLUGIN_VERSION,
          updatedAt: publishedAt,
          risk: "low",
          runtimeMode: "process",
          tools: [],
          uiSurfaces: [],
        },
      ],
    }),
  )
  await Bun.write(
    path.join(paths.entries, `${PLUGIN_ID}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "Official registry install test plugin",
      repo: "https://github.com/SII-Holos/official-test-plugin",
      author: { name: "SII Holos" },
      verified: true,
      official: true,
      keywords: ["synergy-plugin", "official"],
      versions: [
        {
          version: PLUGIN_VERSION,
          downloadUrl: `file://${artifact.tarballPath}`,
          signatureUrl: `file://${artifact.tarballPath}.sig`,
          signature: { algorithm: "ed25519", signer: artifact.signer },
          integrity: `sha256-${artifact.tarballHash}`,
          manifestHash: artifact.manifestHash,
          permissionsHash: artifact.permissionsHash,
          risk: "low",
          runtimeMode: "process",
          permissionsSummary: [],
          tools: [],
          uiSurfaces: [],
          publishedAt,
        },
      ],
      yankedVersions: [],
    }),
  )
}

async function withOfficialRegistry<T>(
  artifact: Awaited<ReturnType<typeof buildSignedArtifact>>,
  fn: () => Promise<T>,
) {
  const previousDomain = await Config.domainGet("plugins")
  await writeOfficialCache(artifact)
  try {
    await Config.domainUpdate(
      "plugins",
      {
        ...previousDomain,
        pluginMarketplace: {
          ...PLUGIN_MARKETPLACE_DEFAULTS,
          enabled: true,
          registryUrl: REGISTRY_URL,
        },
      },
      { mode: "replace-domain" },
    )
    await Config.reload("global")
    return await ScopeContext.provide({ scope: Scope.home(), fn })
  } finally {
    await Config.domainUpdate("plugins", previousDomain, { mode: "replace-domain" })
    await Config.reload("global")
  }
}

describe("official registry install verification", () => {
  test("accepts an artifact whose manifest display name differs from the registry id", async () => {
    await using tmp = await tmpdir({ git: true })
    const artifact = await buildSignedArtifact("Official Test Plugin")
    try {
      await withOfficialRegistry(artifact, async () => {
        const verified = await PluginMarketplaceRegistry.verifyOfficialArtifact(PLUGIN_ID, PLUGIN_VERSION)
        expect(verified.manifest.id).toBe(PLUGIN_ID)
        expect(verified.manifest.name).toBe("Official Test Plugin")
      })
    } finally {
      fs.rmSync(artifact.dir, { recursive: true, force: true })
    }
  })

  test("registry install returns 422 with the verification message instead of a 500", async () => {
    await using tmp = await tmpdir({ git: true })
    const artifact = await buildSignedArtifact("Official Test Plugin")
    try {
      await withOfficialRegistry(artifact, async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/registry/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: PLUGIN_ID, version: "9.9.9", source: "official" }),
        })
        expect(res.status).toBe(422)
        const body = await res.json()
        expect(body.code).toBe("plugin_artifact_verification_failed")
        expect(body.message).toBe(`Official registry version not found: ${PLUGIN_ID}@9.9.9`)
      })
    } finally {
      fs.rmSync(artifact.dir, { recursive: true, force: true })
    }
  })
})
