import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import { signPluginTarball } from "../../../plugin-kit/src/commands/sign"
import { registryEntry } from "../../../plugin-kit/src/lib/market-entry"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { Config } from "../../src/config/config"
import { PLUGIN_MARKETPLACE_DEFAULTS } from "../../src/config/schema"
import { PluginMarketplaceRegistry } from "../../src/plugin/marketplace-registry"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { Log } from "../../src/util/log"
import { readApprovals } from "../../src/plugin/consent/approval-store"

Log.init({ print: false })

const PLUGIN_ID = "official-test-plugin"
const PLUGIN_VERSION = "1.0.0"
const REGISTRY_URL = "https://registry.test/synergy/plugins/registry.json"

function buildManifest(displayName: string): PluginManifestType {
  return PluginManifest.parse({
    manifestVersion: 1,
    apiVersion: "4.0",
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
  const manifest = buildManifest(displayName)
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

  await signPluginTarball(tarballPath)
  const entry = registryEntry({
    tarballPath,
    repo: "https://github.com/SII-Holos/official-test-plugin",
    downloadUrl: `file://${tarballPath}`,
    signatureUrl: `file://${tarballPath}.sig`,
    publishedAt: "2026-07-20T00:00:00.000Z",
  })

  return { dir, tarballPath, entry }
}

async function writeOfficialCache(artifact: Awaited<ReturnType<typeof buildSignedArtifact>>) {
  const paths = PluginMarketplaceRegistry.cachePaths(REGISTRY_URL)
  fs.mkdirSync(paths.entries, { recursive: true })
  const publishedAt = new Date("2026-07-20T00:00:00.000Z").toISOString()
  const entry = { ...artifact.entry, verified: true, official: true }
  const version = entry.versions[0]!
  await Bun.write(
    paths.registry,
    JSON.stringify({
      schemaVersion: 2,
      updatedAt: publishedAt,
      plugins: [
        {
          id: PLUGIN_ID,
          name: PLUGIN_ID,
          description: entry.description,
          repo: entry.repo,
          entry: "plugins/official-test-plugin.json",
          author: entry.author,
          verified: true,
          official: true,
          keywords: entry.keywords,
          latestVersion: PLUGIN_VERSION,
          updatedAt: publishedAt,
          runtimeMode: "process",
          tools: version.tools,
          uiSurfaces: version.uiSurfaces,
        },
      ],
    }),
  )
  await Bun.write(path.join(paths.entries, `${PLUGIN_ID}.json`), JSON.stringify(entry))
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

  test("installs an official signed artifact in one step", async () => {
    await using tmp = await tmpdir({ git: true })
    const artifact = await buildSignedArtifact("Official Test Plugin")
    try {
      await withOfficialRegistry(artifact, async () => {
        const app = Server.App()
        const installRes = await app.request("/api/plugins/registry/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: PLUGIN_ID, version: PLUGIN_VERSION, source: "official" }),
        })
        expect(installRes.status).toBe(200)
        const installBody = (await installRes.json()) as {
          id: string
          loaded: boolean
          health: string
          installation: { kind: string; registry?: string; spec?: string }
          manifest: PluginManifestType
        }
        expect(installBody.id).toBe(PLUGIN_ID)
        expect(installBody.loaded).toBe(true)
        expect(installBody.health).toBe("loaded")
        expect(installBody.installation).toEqual({
          kind: "registry",
          registry: "official",
          spec: expect.any(String),
        })
        expect(installBody.manifest.version).toBe(PLUGIN_VERSION)
        expect(await readApprovals()).toContainEqual(
          expect.objectContaining({
            schemaVersion: 2,
            pluginId: PLUGIN_ID,
            source: "official",
            signer: artifact.entry.versions[0]!.signature.signer,
            approvedBy: "policy",
          }),
        )
      })
    } finally {
      fs.rmSync(artifact.dir, { recursive: true, force: true })
    }
  })
})
