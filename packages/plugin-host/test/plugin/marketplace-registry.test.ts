import { PLUGIN_MARKETPLACE_DEFAULTS } from "../../src/config-schema"
import { expect, test } from "bun:test"
import { subtle } from "node:crypto"
import path from "node:path"
import { compilePluginManifest, definePlugin, PluginArtifact } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { sha256File } from "@ericsanchezok/synergy-harness/util/crypto"
import fs from "node:fs/promises"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { PluginMarketplaceRegistry as Registry } from "../../src/plugin/marketplace-registry"

test("marketplace isolates URL caches, refreshes atomically and preserves cached entries on remote failure", async () => {
  await using tmp = await tmpdir({ git: true })
  const domain = await Config.domainGet("plugins")
  let offline = false
  let registryRequests = 0
  const updatedAt = "2026-09-08T00:00:00.000Z"
  const summary = {
    id: "demo",
    name: "demo",
    description: "Research helper",
    repo: "https://example.com/demo",
    entry: "demo.json",
    author: { name: "Fixture" },
    verified: false,
    official: true,
    keywords: ["science"],
    updatedAt,
    runtimeMode: "process",
    tools: [],
    uiSurfaces: [],
    latestVersion: "1.0.0",
    risk: "low",
  }
  const registry = { schemaVersion: 1, updatedAt, plugins: [summary] }
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      if (offline) return new Response("offline", { status: 503 })
      if (new URL(request.url).pathname.endsWith("registry.json")) {
        registryRequests++
        return Response.json(registry)
      }
      return Response.json({
        schemaVersion: 1,
        id: summary.id,
        name: summary.name,
        description: summary.description,
        repo: summary.repo,
        author: summary.author,
        verified: false,
        official: true,
        keywords: summary.keywords,
        yankedVersions: [],
        versions: [
          {
            version: "1.0.0",
            downloadUrl: `${server.url}demo.tgz`,
            signatureUrl: `${server.url}demo.sig`,
            signature: { algorithm: "ed25519", signer: "a".repeat(64) },
            integrity: `sha256-${"b".repeat(64)}`,
            manifestHash: "manifest",
            permissionsHash: "permissions",
            runtimeMode: "process",
            risk: "low",
            permissionsSummary: [{ key: "file_read", description: "Read files", risk: "low" }],
            tools: ["read"],
            uiSurfaces: [],
            publishedAt: updatedAt,
          },
        ],
      })
    },
  })
  const registryUrl = `${server.url}registry.json`
  const cache = Registry.cachePaths(registryUrl)
  try {
    await Config.domainUpdate(
      "plugins",
      {
        ...domain,
        pluginMarketplace: {
          ...PLUGIN_MARKETPLACE_DEFAULTS,
          enabled: true,
          registryUrl,
          cacheTtlMs: 60000,
          offlineCache: true,
          requestTimeoutMs: 1000,
        },
      },
      { mode: "replace-domain" },
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Registry.currentConfig()
        expect(Registry.resolveEntryUrl(registryUrl, "demo.json")).toBe(`${server.url}demo.json`)
        expect(Registry.cachePaths(`${server.url}another.json`).root).not.toBe(cache.root)
        const first = await Registry.searchOfficial({ q: "SCIENCE", limit: 1 })
        expect(first.total).toBe(1)
        expect(first.plugins[0]).toMatchObject({ id: "demo", source: "official" })
        expect((await Registry.searchOfficial({ q: "absent" })).total).toBe(0)
        expect((await Registry.searchOfficial({ offset: 1 })).plugins).toEqual([])
        await Registry.prefetchRegistry()
        expect(registryRequests).toBe(1)
        const entry = await Registry.getOfficialEntry("demo")
        expect(entry?.versions[0]?.version).toBe("1.0.0")
        expect(entry?.tools).toEqual(["read"])
        expect(await Registry.getOfficialEntry("unknown")).toBeNull()
        expect(await Registry.getOfficialEntry("demo")).toEqual(entry)
        await Promise.all([Registry.refreshNow(config), Registry.refreshNow(config)])
        expect(registryRequests).toBe(2)
        expect(await fs.readdir(cache.entries)).toEqual([])
        await Registry.getOfficialEntry("demo")
        offline = true
        await expect(Registry.refreshNow(config)).rejects.toThrow("HTTP 503")
        expect(await Bun.file(cache.registry).json()).toEqual(registry)
        expect(await Registry.getOfficialEntry("demo")).toEqual(entry)
        await fs.rm(cache.registry)
        expect(await Registry.getOfficialEntry("demo")).toMatchObject({ id: "demo", versions: entry!.versions })
      },
    })
  } finally {
    server.stop(true)
    await Config.domainUpdate("plugins", domain, { mode: "replace-domain" })
    await fs.rm(cache.root, { recursive: true, force: true })
  }
})

test("disabled marketplace performs no network or cache writes", async () => {
  await using tmp = await tmpdir({ git: true })
  const domain = await Config.domainGet("plugins")
  try {
    await Config.domainUpdate(
      "plugins",
      {
        ...domain,
        pluginMarketplace: {
          ...PLUGIN_MARKETPLACE_DEFAULTS,
          enabled: false,
          registryUrl: "https://invalid.example/registry.json",
        },
      },
      { mode: "replace-domain" },
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Registry.refreshNow()).toEqual({ refreshedAt: null })
        await Registry.prefetchRegistry()
        expect(await Registry.searchOfficial()).toEqual({ plugins: [], total: 0 })
        expect(await Registry.getOfficialEntry("demo")).toBeNull()
      },
    })
  } finally {
    await Config.domainUpdate("plugins", domain, { mode: "replace-domain" })
  }
})

test("official artifact verification checks reviewed signatures and repairs corrupt cached downloads", async () => {
  await using tmp = await tmpdir({ git: true })
  const domain = await Config.domainGet("plugins")
  const id = "verified-artifact"
  const version = "1.0.0"
  const manifest = compilePluginManifest(
    definePlugin({ id, version, description: "Verified fixture", contributions: [] }),
    { generation: "fixture" },
  )
  const stage = path.join(tmp.path, "stage")
  for (const file of PluginArtifact.requiredFiles)
    await Bun.write(path.join(stage, file), file === "plugin.json" ? JSON.stringify(manifest) : "{}")
  const artifact = path.join(tmp.path, "artifact.tgz")
  expect(Bun.spawnSync(["tar", "-czf", artifact, "-C", stage, ...PluginArtifact.requiredFiles]).exitCode).toBe(0)
  const keys = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
  const signer = Buffer.from(await subtle.exportKey("raw", keys.publicKey)).toString("hex")
  const payload = {
    tarballHash: sha256File(artifact),
    manifestHash: computeManifestHash(manifest),
    permissionsHash: computePermissionsHash(manifest, []),
  }
  const signature = {
    signatureVersion: 1,
    pluginId: id,
    version,
    algorithm: "ed25519",
    signer,
    signedAt: Date.now(),
    payload,
    signature: Buffer.from(
      await subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(JSON.stringify(payload))),
    ).toString("hex"),
  }
  let downloads = 0
  const updatedAt = new Date().toISOString()
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const pathname = new URL(request.url).pathname
      if (pathname === "/artifact.tgz") {
        downloads++
        return new Response(Bun.file(artifact))
      }
      if (pathname === "/artifact.sig") return Response.json(signature)
      const summary = {
        id,
        name: id,
        description: "Verified fixture",
        repo: "https://example.com/plugin",
        entry: "entry.json",
        author: { name: "Fixture" },
        verified: true,
        official: true,
        keywords: [],
        updatedAt,
        runtimeMode: "process",
        tools: [],
        uiSurfaces: [],
        latestVersion: version,
        risk: "low",
      }
      if (pathname === "/registry.json") return Response.json({ schemaVersion: 1, updatedAt, plugins: [summary] })
      return Response.json({
        id,
        name: id,
        description: summary.description,
        repo: summary.repo,
        author: summary.author,
        verified: true,
        official: true,
        keywords: [],
        schemaVersion: 1,
        versions: [
          {
            version,
            downloadUrl: `${server.url}artifact.tgz`,
            signatureUrl: `${server.url}artifact.sig`,
            signature: { algorithm: "ed25519", signer },
            integrity: `sha256-${payload.tarballHash}`,
            manifestHash: payload.manifestHash,
            permissionsHash: payload.permissionsHash,
            runtimeMode: "process",
            risk: "low",
            permissionsSummary: [],
            tools: [],
            uiSurfaces: [],
            publishedAt: updatedAt,
          },
        ],
        yankedVersions: [],
      })
    },
  })
  const registryUrl = `${server.url}registry.json`
  try {
    await Config.domainUpdate(
      "plugins",
      { ...domain, pluginMarketplace: { ...PLUGIN_MARKETPLACE_DEFAULTS, enabled: true, registryUrl } },
      { mode: "replace-domain" },
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const verified = await Registry.verifyOfficialArtifact(id, version)
        expect(verified.manifest.id).toBe(id)
        expect(verified.signature.signer).toBe(signer)
        expect(downloads).toBe(1)
        await Registry.verifyOfficialArtifact(id, version)
        expect(downloads).toBe(1)
        await Bun.write(verified.tarballPath, "corrupt cached artifact")
        await Registry.verifyOfficialArtifact(id, version)
        expect(downloads).toBe(2)
        await Bun.write(verified.signaturePath, JSON.stringify({ ...signature, pluginId: "different-plugin" }))
        await expect(Registry.verifyOfficialArtifact(id, version)).rejects.toThrow("signature plugin id mismatch")
        expect(await Bun.file(verified.tarballPath).exists()).toBe(false)
        expect(await Bun.file(verified.signaturePath).exists()).toBe(false)
        await expect(Registry.verifyOfficialArtifact(id, "missing-version")).rejects.toThrow("version not found")
      },
    })
  } finally {
    server.stop(true)
    await Config.domainUpdate("plugins", domain, { mode: "replace-domain" })
    await fs.rm(Registry.cachePaths(registryUrl).root, { recursive: true, force: true })
  }
})
