import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { Scope } from "../../src/scope"
import { Config } from "../../src/config/config"
import {
  readApprovals,
  writeApprovals,
  computeManifestHash,
  computePermissionsHash,
} from "../../src/plugin/consent/approval-store"
import { buildApprovalReview, generateReviewToken } from "../../src/plugin/consent/approval-service"
import * as Lockfile from "../../src/plugin/lockfile"
import { getDisabledPlugins, resetAllPluginState } from "../../src/plugin/loader"
import path from "path"
import fs from "fs"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { compilePluginManifest, definePlugin, operation, capability } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { sha256File } from "../../src/util/crypto"
import { localRegistryPath } from "../../src/plugin/local-registry-store"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PluginFixture {
  dir: string
  manifest: ReturnType<typeof compilePluginManifest>
  runtimePath: string
  pluginId: string
  spec: string
}

function createPluginFixture(rootDir: string, pluginId: string, generation = "test-generation"): PluginFixture {
  const dir = path.join(rootDir, `plugin-${pluginId}`)
  fs.mkdirSync(dir, { recursive: true })

  const definition = definePlugin({
    id: pluginId,
    version: "1.0.0",
    description: `Plugin for approval testing: ${pluginId}`,
    capabilities: [capability("workspace.read")],
    contributions: [
      operation({
        id: "read",
        type: "query",
        input: z.object({}),
        output: z.object({}),
        handler: async () => ({}),
      }),
    ],
  })

  const runtimeDir = path.join(dir, "runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const runtimePath = path.join(runtimeDir, "index.js")
  fs.writeFileSync(runtimePath, "export default {}\n")

  const manifest = compilePluginManifest(definition, {
    generation,
    runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
  })

  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))

  return {
    dir,
    manifest,
    runtimePath,
    pluginId,
    spec: pathToFileURL(dir).href,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin approval routes", () => {
  let app: ReturnType<typeof Server.App>
  let tmp: Awaited<ReturnType<typeof tmpdir>>
  let scope: Scope
  let previousDomain: Record<string, unknown>
  let previousLockfile: Awaited<ReturnType<typeof Lockfile.read>>
  let previousApprovals: Awaited<ReturnType<typeof readApprovals>>

  beforeAll(async () => {
    tmp = await tmpdir({ git: true, config: { plugin: [] } })
    scope = await tmp.scope()
    app = await Server.App()
  })

  afterAll(async () => {
    if (tmp) await tmp[Symbol.asyncDispose]()
  })

  async function saveState(): Promise<void> {
    previousDomain = await Config.domainGet("plugins")
    previousLockfile = await Lockfile.read()
    previousApprovals = await readApprovals()
  }

  async function restoreState(): Promise<void> {
    await Config.domainUpdate("plugins", previousDomain as Parameters<typeof Config.domainUpdate>[1], {
      mode: "replace-domain",
    })
    await Lockfile.write(previousLockfile)
    await writeApprovals(previousApprovals)
    await resetAllPluginState()
  }

  // -----------------------------------------------------------------------
  // Test 1: POST /approve rejects legacy fields
  // -----------------------------------------------------------------------
  test("POST /approve rejects legacy body fields (manifest/capabilities/source/path)", async () => {
    await saveState()
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const res = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: "any-plugin" },
              reviewToken: "any",
              manifest: {},
              capabilities: [],
              source: "local",
              path: "/tmp",
            }),
          })
          expect(res.status).toBeGreaterThanOrEqual(400)
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 2: POST /approve rejects payloads missing reviewToken
  // -----------------------------------------------------------------------
  test("POST /approve returns 400 for missing reviewToken", async () => {
    await saveState()
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const res = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: "any-plugin" },
            }),
          })
          expect(res.status).toBe(400)
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 3: GET /:pluginId/approval-review returns 404 for non-existent
  // -----------------------------------------------------------------------
  test("GET /:pluginId/approval-review returns 404 for non-existent plugin", async () => {
    await saveState()
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const res = await app.request("/api/plugins/nonexistent/approval-review")
          expect(res.status).toBe(404)
          const body = (await res.json()) as { code: string }
          expect(body.code).toBe("plugin_not_found")
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 4: POST /approve returns 404 for non-existent plugin
  // -----------------------------------------------------------------------
  test("POST /approve returns 404 for non-existent plugin", async () => {
    await saveState()
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const res = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: "nonexistent" },
              reviewToken: "invalid-token",
            }),
          })
          expect(res.status).toBe(404)
          const body = (await res.json()) as { code: string }
          expect(body.code).toBe("plugin_not_found")
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 5: Full configured approval flow
  // -----------------------------------------------------------------------
  test("configured plugin: GET review returns canonical data and POST approve loads plugin", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "config-approve-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = Array.isArray(domain.plugin) ? [...domain.plugin, fixture.spec] : [fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          const lockfileBefore = await Lockfile.read()
          const configBefore = await Config.domainGet("plugins")

          // Step 1: GET approval review
          const reviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes.status).toBe(200)
          const review = (await reviewRes.json()) as Record<string, unknown>
          expect(review.pluginId).toBe(fixture.pluginId)
          expect(review.name).toBe(fixture.pluginId)
          expect(review.version).toBe("1.0.0")
          expect(review.capabilities).toEqual(["workspace.read"])
          expect(typeof review.reviewToken).toBe("string")
          expect((review.reviewToken as string).length).toBeGreaterThan(0)
          expect(review.risk).toBe("medium")
          expect(review.trust).toBe("declarative")
          expect(review.target).toEqual({ kind: "configured", pluginId: fixture.pluginId })

          const reviewToken = review.reviewToken as string

          // Step 2: POST approve with token
          const approveRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken,
            }),
          })
          expect(approveRes.status).toBe(200)
          const status = (await approveRes.json()) as Record<string, unknown>
          expect(status.id).toBe(fixture.pluginId)
          expect(status.loaded).toBe(true)
          expect(status.health).toBe("loaded")

          // Step 3: Assert approval hashes verify against actual manifest
          const approvals = await readApprovals()
          const approval = approvals.find((r) => r.pluginId === fixture.pluginId)
          expect(approval).toBeDefined()
          if (!approval) throw new Error("approval missing")
          expect(approval.manifestHash).toBe(computeManifestHash(fixture.manifest))
          const capabilities = fixture.manifest.capabilities.map((c) => c.id)
          expect(approval.capabilitiesHash).toBe(computePermissionsHash(fixture.manifest, capabilities))
          expect(approval.approvedBy).toBe("user")
          expect(approval.status).toBe("approved")

          // Step 4: Assert config unchanged by approval
          const configAfter = await Config.domainGet("plugins")
          expect(configAfter.plugin).toEqual(configBefore.plugin)
          expect(configAfter.pluginConfig ?? {}).toEqual(configBefore.pluginConfig ?? {})

          // Step 5: Assert lock snapshots unchanged by configured approval
          const lockfileAfter = await Lockfile.read()
          expect(lockfileAfter).toEqual(lockfileBefore)
        },
      })
    } finally {
      await restoreState()
    }
  })

  test("configured plugin approval resolves relative specs from the active Scope", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "relative-approve-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const relativeSpec = `file://./${path.relative(tmp.path, fixture.dir)}`
          const plugins = Array.isArray(domain.plugin) ? [...domain.plugin, relativeSpec] : [relativeSpec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })
          await resetAllPluginState()

          const review = await buildApprovalReview({ kind: "configured", pluginId: fixture.pluginId })
          expect(review.pluginId).toBe(fixture.pluginId)
          expect(review.target).toEqual({ kind: "configured", pluginId: fixture.pluginId })
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 6: Stale review — mutate manifest after getting review token
  // -----------------------------------------------------------------------
  test("stale review: mutating manifest after GET review causes POST to return 409 with fresh review", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "stale-review-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          const configBefore = await Config.domainGet("plugins")
          const lockfileBefore = await Lockfile.read()

          // Step 1: GET review for current manifest
          const reviewRes1 = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes1.status).toBe(200)
          const review1 = (await reviewRes1.json()) as Record<string, unknown>
          const oldToken = review1.reviewToken as string

          // Step 2: Mutate manifest — change capabilities
          const definition2 = definePlugin({
            id: fixture.pluginId,
            version: "1.0.0",
            description: "Updated stale-review plugin",
            capabilities: [capability("workspace.read"), capability("workspace.write")],
            contributions: [
              operation({
                id: "read",
                type: "query",
                input: z.object({}),
                output: z.object({}),
                handler: async () => ({}),
              }),
            ],
          })
          const manifest2 = compilePluginManifest(definition2, {
            generation: "test-generation-v2",
            runtime: { entry: "runtime/index.js", sha256: sha256File(fixture.runtimePath) },
          })
          fs.writeFileSync(path.join(fixture.dir, "plugin.json"), JSON.stringify(manifest2, null, 2))

          // Step 3: POST old token → 409 stale_review
          const staleRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken: oldToken,
            }),
          })
          expect(staleRes.status).toBe(409)
          const staleBody = (await staleRes.json()) as Record<string, unknown>
          expect(staleBody.code).toBe("stale_review")
          expect(staleBody.review).toBeDefined()
          const freshReview = staleBody.review as Record<string, unknown>
          expect(freshReview.reviewToken).not.toBe(oldToken)
          expect(freshReview.capabilities).toEqual(["workspace.read", "workspace.write"])

          // Step 4: Assert approvals, config, and lock unchanged by stale POST
          const approvals = await readApprovals()
          expect(approvals.filter((r) => r.pluginId === fixture.pluginId)).toHaveLength(0)
          const configAfter = await Config.domainGet("plugins")
          expect(configAfter.plugin).toEqual(configBefore.plugin)
          expect(configAfter.pluginConfig ?? {}).toEqual(configBefore.pluginConfig ?? {})
          const lockfileAfter = await Lockfile.read()
          expect(lockfileAfter).toEqual(lockfileBefore)
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 7: Idempotency — repeat same POST returns loaded, subsequent GET
  //          review returns 409 approval_not_required
  // -----------------------------------------------------------------------
  test("idempotency: repeat POST approve is idempotent and GET approval-review returns 409", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "idempotent-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          // Step 1: GET review
          const reviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes.status).toBe(200)
          const review = (await reviewRes.json()) as Record<string, unknown>
          const reviewToken = review.reviewToken as string

          // Step 2: First POST → loaded
          const res1 = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken,
            }),
          })
          expect(res1.status).toBe(200)

          // Step 3: Record approval state
          const approvalsAfter1 = await readApprovals()
          const approvalRecords = approvalsAfter1.filter((r) => r.pluginId === fixture.pluginId)
          expect(approvalRecords).toHaveLength(1)
          const approvedAt1 = approvalRecords[0]!.approvedAt

          // Step 4: Second POST with same token → still 200, no new approval
          const res2 = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken,
            }),
          })
          expect(res2.status).toBe(200)
          const status2 = (await res2.json()) as Record<string, unknown>
          expect(status2.loaded).toBe(true)

          // Step 5: Approval count unchanged, approvedAt unchanged
          const approvalsAfter2 = await readApprovals()
          const approvalRecords2 = approvalsAfter2.filter((r) => r.pluginId === fixture.pluginId)
          expect(approvalRecords2).toHaveLength(1)
          expect(approvalRecords2[0]!.approvedAt).toBe(approvedAt1)

          // Step 6: GET review → 409 approval_not_required
          const reviewRes2 = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes2.status).toBe(409)
          const reviewBody2 = (await reviewRes2.json()) as { code: string }
          expect(reviewBody2.code).toBe("approval_not_required")
        },
      })
    } finally {
      await restoreState()
    }
  })

  test("loaded plugin with missing persisted approval re-enters the approval transaction", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "loaded-missing-approval-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          const initialReviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(initialReviewRes.status).toBe(200)
          const initialReview = (await initialReviewRes.json()) as { reviewToken: string }
          const initialApproveRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken: initialReview.reviewToken,
            }),
          })
          expect(initialApproveRes.status).toBe(200)

          await writeApprovals((await readApprovals()).filter((approval) => approval.pluginId !== fixture.pluginId))
          expect(await readApprovals()).not.toContainEqual(expect.objectContaining({ pluginId: fixture.pluginId }))

          const replacementReviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(replacementReviewRes.status).toBe(200)
          const replacementReview = (await replacementReviewRes.json()) as { reviewToken: string }
          const replacementApproveRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken: replacementReview.reviewToken,
            }),
          })
          expect(replacementApproveRes.status).toBe(200)
          expect(await readApprovals()).toContainEqual(
            expect.objectContaining({ pluginId: fixture.pluginId, status: "approved" }),
          )
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 8: Invalid configured artifact → 422 plugin_invalid
  // -----------------------------------------------------------------------
  test("invalid configured plugin: integrity mismatch returns 422 plugin_invalid", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "invalid-plugin-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          // Seed a lockfile entry so resolveConfiguredTarget can find the spec
          // even though the disabled list won't have the manifest id (the
          // integrity failure happens before the manifest id is known).
          const lockfile = await Lockfile.read()
          await Lockfile.write(
            Lockfile.addEntry(lockfile, fixture.pluginId, {
              spec: fixture.spec,
              source: "local",
              version: fixture.manifest.version,
              apiVersion: fixture.manifest.apiVersion,
              generation: fixture.manifest.artifacts.generation,
              resolved: path.join(fixture.dir, "plugin.json"),
              manifestHash: "dummy",
            }),
          )

          // Tamper the runtime file so its sha256 no longer matches the manifest
          fs.writeFileSync(fixture.runtimePath, "export default { tampered: true }\n")

          // GET review → 422 plugin_invalid
          const reviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes.status).toBe(422)
          const body = (await reviewRes.json()) as { code: string }
          expect(body.code).toBe("plugin_invalid")

          // Assert no approvals written
          const approvals = await readApprovals()
          expect(approvals.filter((r) => r.pluginId === fixture.pluginId)).toHaveLength(0)
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 9: POST /approve with invalid review token → 409 stale_review
  // -----------------------------------------------------------------------
  test("POST /approve with invalid review token returns 409 stale_review", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "bad-token-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          const configBefore = await Config.domainGet("plugins")
          const lockfileBefore = await Lockfile.read()

          // POST with obviously invalid token
          const res = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken: "deadbeef-not-a-real-token",
            }),
          })
          expect(res.status).toBe(409)
          const body = (await res.json()) as { code: string; review: Record<string, unknown> }
          expect(body.code).toBe("stale_review")
          expect(body.review).toBeDefined()
          expect(body.review.reviewToken).toBeDefined()
          expect((body.review.reviewToken as string).length).toBeGreaterThan(0)

          // Assert no approvals, config, or lock changed by stale POST
          const approvals = await readApprovals()
          expect(approvals.filter((r) => r.pluginId === fixture.pluginId)).toHaveLength(0)
          const configAfter = await Config.domainGet("plugins")
          expect(configAfter.plugin).toEqual(configBefore.plugin)
          expect(configAfter.pluginConfig ?? {}).toEqual(configBefore.pluginConfig ?? {})
          const lockfileAfter = await Lockfile.read()
          expect(lockfileAfter).toEqual(lockfileBefore)
        },
      })
    } finally {
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 10: Unified POST /approve with registry target bypasses auto-approval
  // -----------------------------------------------------------------------
  test("registry unified approve: POST /approve with registry target loads plugin via local registry", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "reg-unified-test")
    const registryVersion = "1.0.0"
    try {
      // Build a local registry that resolves the fixture
      const registryPath = localRegistryPath()
      fs.mkdirSync(path.dirname(registryPath), { recursive: true })
      const registry = {
        plugins: [
          {
            id: fixture.pluginId,
            versions: [
              {
                version: registryVersion,
                downloadUrl: fixture.spec,
              },
            ],
          },
        ],
      }
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2))

      await ScopeContext.provide({
        scope,
        async fn() {
          // Build a valid review token for the registry target
          const registryTarget = {
            kind: "registry" as const,
            pluginId: fixture.pluginId,
            version: registryVersion,
            source: "local" as const,
          }
          const capabilities = fixture.manifest.capabilities.map((c) => c.id)
          const token = generateReviewToken(registryTarget, fixture.manifest, capabilities)

          // POST /approve with registry target
          const approveRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: registryTarget, reviewToken: token }),
          })
          expect(approveRes.status).toBe(200)
          const status = (await approveRes.json()) as Record<string, unknown>
          expect(status.id).toBe(fixture.pluginId)
          expect(status.loaded).toBe(true)
          expect(status.health).toBe("loaded")

          // Approval record persisted
          const approvals = await readApprovals()
          const approval = approvals.find((r) => r.pluginId === fixture.pluginId)
          expect(approval).toBeDefined()
          if (!approval) throw new Error("approval missing")
          expect(approval.approvedBy).toBe("user")
          expect(approval.status).toBe("approved")
          expect(approval.source).toBe("local")
          expect(approval.version).toBe(registryVersion)
        },
      })
    } finally {
      // Clean up registry file
      try {
        fs.unlinkSync(localRegistryPath())
      } catch {}
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 11: POST /approve with registry target rejects stale token
  // -----------------------------------------------------------------------
  test("registry unified approve: stale token returns 409 with fresh review", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "reg-stale-test")
    const registryVersion = "1.0.0"
    try {
      const registryPath = localRegistryPath()
      fs.mkdirSync(path.dirname(registryPath), { recursive: true })
      const registry = {
        plugins: [
          {
            id: fixture.pluginId,
            versions: [{ version: registryVersion, downloadUrl: fixture.spec }],
          },
        ],
      }
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2))

      await ScopeContext.provide({
        scope,
        async fn() {
          const registryTarget = {
            kind: "registry" as const,
            pluginId: fixture.pluginId,
            version: registryVersion,
            source: "local" as const,
          }
          // Stale token — mismatched manifest
          const badToken = "deadbeef-registry-stale"
          const staleRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: registryTarget, reviewToken: badToken }),
          })
          expect(staleRes.status).toBe(409)
          const staleBody = (await staleRes.json()) as Record<string, unknown>
          expect(staleBody.code).toBe("stale_review")
          expect(staleBody.review).toBeDefined()

          // No approvals written
          const approvals = await readApprovals()
          expect(approvals.filter((r) => r.pluginId === fixture.pluginId)).toHaveLength(0)
        },
      })
    } finally {
      try {
        fs.unlinkSync(localRegistryPath())
      } catch {}
      await restoreState()
    }
  })

  test("registry unified approve: manifest id mismatch returns 422 without writing approval", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "reg-manifest-actual")
    const targetPluginId = "reg-manifest-target"
    const registryVersion = "1.0.0"
    try {
      const registryPath = localRegistryPath()
      fs.mkdirSync(path.dirname(registryPath), { recursive: true })
      fs.writeFileSync(
        registryPath,
        JSON.stringify(
          {
            plugins: [
              {
                id: targetPluginId,
                versions: [{ version: registryVersion, downloadUrl: fixture.spec }],
              },
            ],
          },
          null,
          2,
        ),
      )

      await ScopeContext.provide({
        scope,
        async fn() {
          const response = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: {
                kind: "registry",
                pluginId: targetPluginId,
                version: registryVersion,
                source: "local",
              },
              reviewToken: "invalid-for-mismatched-manifest",
            }),
          })

          expect(response.status).toBe(422)
          const body = (await response.json()) as Record<string, unknown>
          expect(body.code).toBe("plugin_invalid")
          expect(body.message).toBe(`Manifest plugin id ${fixture.pluginId} does not match target ${targetPluginId}`)
          const approvals = await readApprovals()
          expect(approvals.filter((record) => record.pluginId === targetPluginId)).toHaveLength(0)
        },
      })
    } finally {
      try {
        fs.unlinkSync(localRegistryPath())
      } catch {}
      await restoreState()
    }
  })

  // -----------------------------------------------------------------------
  // Test 12: Approval removal disables the plugin — rollback gate
  // -----------------------------------------------------------------------
  test("configured plugin: removing approval after load disables the plugin on state reload", async () => {
    await saveState()
    const fixture = createPluginFixture(tmp.path, "rollback-gate-test")
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const domain = await Config.domainGet("plugins")
          const plugins = [...(Array.isArray(domain.plugin) ? domain.plugin : []), fixture.spec]
          await Config.domainUpdate("plugins", { ...domain, plugin: plugins }, { mode: "replace-domain" })

          // Step 1: GET review and POST approve → loaded
          const reviewRes = await app.request(`/api/plugins/${fixture.pluginId}/approval-review`)
          expect(reviewRes.status).toBe(200)
          const review = (await reviewRes.json()) as Record<string, unknown>
          const approveRes = await app.request("/api/plugins/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target: { kind: "configured", pluginId: fixture.pluginId },
              reviewToken: review.reviewToken as string,
            }),
          })
          expect(approveRes.status).toBe(200)

          // Step 2: Remove the approval record and reset loader state
          const approvals = await readApprovals()
          await writeApprovals(approvals.filter((r) => r.pluginId !== fixture.pluginId))
          await resetAllPluginState()

          // Step 3: Plugin is now disabled with phase "approval"
          const disabled = await getDisabledPlugins()
          const entry = disabled.find((d) => d.pluginId === fixture.pluginId)
          expect(entry).toBeDefined()
          expect(entry!.phase).toBe("approval")
        },
      })
    } finally {
      await restoreState()
    }
  })
})
