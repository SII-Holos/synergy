import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { subtle } from "node:crypto"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { Config } from "../../src/config/config"
import { PLUGIN_MARKETPLACE_DEFAULTS } from "../../src/config/schema"
import { PluginMarketplaceRegistry } from "../../src/plugin/marketplace-registry"
import { baseCapabilities } from "../../src/plugin/capability"
import { computeManifestHash, computePermissionsHash } from "../../src/plugin/consent/approval-store"
import { sha256File } from "../../src/util/crypto"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

function hex(input: ArrayBuffer): string {
  return Buffer.from(input).toString("hex")
}

function jsonResponse(input: unknown): Response {
  return new Response(JSON.stringify(input), { headers: { "Content-Type": "application/json" } })
}

async function createSignedPluginArtifact(input: { dir: string; id: string; version: string }): Promise<{
  manifest: PluginManifestType
  tarballPath: string
  signature: Record<string, unknown>
  signer: string
  integrity: string
  manifestHash: string
  permissionsHash: string
}> {
  const packageDir = path.join(input.dir, "dist")
  await fs.mkdir(path.join(packageDir, "runtime"), { recursive: true })

  const manifest = PluginManifest.parse({
    name: input.id,
    version: input.version,
    description: "Official plugin fixture",
    author: "Synergy Test",
    repository: "https://github.com/SII-Holos/official-crlf-fixture",
    engines: { synergy: ">=2.4.3" },
    permissions: {},
    runtime: { mode: "process" },
    main: "./runtime/index.js",
  }) as PluginManifestType

  await Bun.write(path.join(packageDir, "plugin.json"), JSON.stringify(manifest, null, 2))
  await Bun.write(path.join(packageDir, "runtime", "index.js"), "export default { id: 'official-crlf-fixture' }\n")

  const capabilities = baseCapabilities(manifest)
  const manifestHash = computeManifestHash(manifest)
  const permissionsHash = computePermissionsHash(manifest, capabilities)
  await Bun.write(path.join(packageDir, "integrity.json"), JSON.stringify({}, null, 2))
  await Bun.write(
    path.join(packageDir, "permissions.summary.json"),
    JSON.stringify({ capabilities, permissionsHash }, null, 2),
  )

  const tarballPath = path.join(input.dir, `${input.id}-${input.version}.synergy-plugin.tgz`)
  const packed = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", packageDir, "."], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (packed.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(packed.stderr) || "failed to create fixture tarball")
  }

  const tarballHash = sha256File(tarballPath)
  const keyPair = (await subtle.generateKey("Ed25519" as any, true, ["sign", "verify"])) as CryptoKeyPair
  const signer = hex(await subtle.exportKey("raw", keyPair.publicKey))
  const payload = { tarballHash, manifestHash, permissionsHash }
  const signatureBytes = await subtle.sign(
    "Ed25519" as any,
    keyPair.privateKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  const signature = {
    signatureVersion: 1,
    pluginId: input.id,
    version: input.version,
    algorithm: "ed25519",
    signer,
    signature: hex(signatureBytes),
    signedAt: Date.parse("2026-06-25T00:00:00.000Z"),
    payload,
  }

  return {
    manifest,
    tarballPath,
    signature,
    signer,
    integrity: `sha256-${tarballHash}`,
    manifestHash,
    permissionsHash,
  }
}

describe("PluginMarketplaceRegistry.verifyOfficialArtifact", () => {
  test("accepts tar listings with CRLF entries from Windows tar", async () => {
    await using tmp = await tmpdir()
    const id = "official-crlf-fixture"
    const version = "1.0.0"
    const artifact = await createSignedPluginArtifact({ dir: tmp.path, id, version })
    const registryUrl = `https://registry.test/synergy/plugins/registry-crlf-${Date.now()}.json`
    const entryUrl = new URL("official-crlf-fixture.json", registryUrl).href
    const downloadUrl = `https://registry.test/releases/${id}-${version}.synergy-plugin.tgz`
    const signatureUrl = `${downloadUrl}.sig`
    const publishedAt = "2026-06-25T00:00:00.000Z"
    const previousDomain = await Config.domainGet("plugins")
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
      if (url === registryUrl) {
        return jsonResponse({
          schemaVersion: 1,
          updatedAt: publishedAt,
          plugins: [
            {
              id,
              name: id,
              description: artifact.manifest.description,
              repo: "https://github.com/SII-Holos/official-crlf-fixture",
              entry: "official-crlf-fixture.json",
              author: { name: "Synergy Test" },
              verified: true,
              official: true,
              keywords: ["synergy-plugin"],
              latestVersion: version,
              updatedAt: publishedAt,
              risk: "low",
              runtimeMode: "process",
              tools: [],
              uiSurfaces: [],
            },
          ],
        })
      }
      if (url === entryUrl) {
        return jsonResponse({
          schemaVersion: 1,
          id,
          name: id,
          description: artifact.manifest.description,
          repo: "https://github.com/SII-Holos/official-crlf-fixture",
          author: { name: "Synergy Test" },
          verified: true,
          official: true,
          keywords: ["synergy-plugin"],
          compatibility: { synergy: ">=2.4.3" },
          versions: [
            {
              version,
              downloadUrl,
              signatureUrl,
              signature: { algorithm: "ed25519", signer: artifact.signer },
              integrity: artifact.integrity,
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
        })
      }
      if (url === signatureUrl) return jsonResponse(artifact.signature)
      if (url === downloadUrl) return new Response(await Bun.file(artifact.tarballPath).arrayBuffer())
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      await Config.domainUpdate(
        "plugins",
        {
          ...previousDomain,
          pluginMarketplace: {
            ...PLUGIN_MARKETPLACE_DEFAULTS,
            enabled: true,
            registryUrl,
            cacheTtlMs: 1,
          },
        },
        { mode: "replace-domain" },
      )
      await Config.reload("global")

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const verified = await PluginMarketplaceRegistry.verifyOfficialArtifact(id, version)
          expect(verified.manifest.name).toBe(id)
          expect(verified.manifest.version).toBe(version)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      await Config.domainUpdate("plugins", previousDomain, { mode: "replace-domain" })
      await Config.reload("global")
    }
  })
})
