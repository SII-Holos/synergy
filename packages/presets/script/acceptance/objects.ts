import fs from "node:fs/promises"
import path from "node:path"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { acceptanceRuntime } from "./runtime"
import type { Settings } from "./settings"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

async function rejection(body: () => Promise<unknown>) {
  try {
    await body()
    return null
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return {
      name: error.name,
      message: error.message,
      code: "code" in error && typeof error.code === "string" ? error.code : null,
      status: "status" in error && typeof error.status === "number" ? error.status : null,
    }
  }
}

type Protocol = "s3" | "oss"
type Fault = "none" | "deny-put" | "missing" | "corrupt" | "truncate"

async function endpoint(directory: string, protocol: Protocol) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const requests: Array<{
    protocol: Protocol
    method: string
    hash: string
    fault: Fault
    signed: boolean
    status: number
    at: number
  }> = []
  let fault: Fault = "none"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const hash = new URL(request.url).pathname.split("/").at(-1)!
      if (!WorkspaceTree.Hash.safeParse(hash).success) return new Response(null, { status: 400 })
      const authorization = request.headers.get("authorization") ?? ""
      const signed = authorization.startsWith(protocol === "s3" ? "AWS4-HMAC-SHA256 " : "OSS4-HMAC-SHA256 ")
      const denied = request.method === "PUT" && fault === "deny-put"
      const file = Bun.file(path.join(directory, hash))
      const missing = request.method === "GET" && (fault === "missing" || !(await file.exists()))
      const status = !signed || denied ? 403 : missing ? 404 : 200
      requests.push({ protocol, method: request.method, hash, fault, signed, status, at: Date.now() })
      const headers = { "x-oss-request-id": "acceptance-fixture", etag: '"acceptance-fixture"' }
      if (status !== 200)
        return new Response(
          `<Error><Code>${status === 403 ? "AccessDenied" : "NoSuchKey"}</Code><Message>Injected object fault</Message><RequestId>acceptance-fixture</RequestId></Error>`,
          { status, headers: { ...headers, "content-type": "application/xml" } },
        )
      if (request.method === "PUT") {
        await Bun.write(file, await request.arrayBuffer(), { mode: 0o600 })
        return new Response(null, { headers })
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (fault === "corrupt") bytes[0] = bytes[0]! ^ 1
      const body = fault === "truncate" ? bytes.subarray(0, Math.max(0, bytes.length - 1)) : bytes
      return new Response(body, { headers: { ...headers, "content-length": String(body.length) } })
    },
  })
  return {
    url: server.url.toString(),
    requests,
    fault(value: Fault) {
      fault = value
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

export function objects(settings: Settings): Driver {
  return async (context) => {
    await using host = await acceptanceRuntime(context.directory, settings)
    return await host.runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const barriers: string[] = []
          const product: unknown[] = []
          let physical: Record<string, unknown>
          let transport: Record<string, unknown>
          let observations: Record<string, unknown>
          if (context.scenario.id === "fault-publication-ack") {
            await Config.updateGlobal({
              resources: { stores: { files: { provider: "local", spec: { namespace: "acceptance" } } } },
            })
            const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
            const selection = { scopeID: "home", workspaceID: workspace.id }
            const oldBytes = Buffer.from(crypto.randomUUID())
            const newBytes = Buffer.from(crypto.randomUUID())
            const initial = await WorkspaceContent.write(selection, {
              path: "record.txt",
              data: oldBytes,
              expectedVersion: null,
            })
            const prepared = await WorkspaceContent.prepareWrite(selection, {
              path: "record.txt",
              data: newBytes,
              expectedVersion: `sha256:${digest(oldBytes)}`,
            })
            const object = (hash: string) =>
              path.join(host.home, ".synergy/data/workspace-objects/acceptance", hash.slice(0, 2), hash)
            const uploadedBytes = new Uint8Array(await Bun.file(object(digest(newBytes))).arrayBuffer())
            const uploadedManifest = new Uint8Array(await Bun.file(object(prepared.manifest)).arrayBuffer())
            const staged = WorkspaceTree.Manifest.parse(JSON.parse(new TextDecoder().decode(uploadedManifest)))
            const before = await WorkspaceContent.read(selection, "record.txt")
            const timeline = [{ stage: "bytes-uploaded", at: Date.now(), manifest: prepared.manifest }]
            if (digest(uploadedBytes) === digest(newBytes) && digest(uploadedManifest) === prepared.manifest)
              barriers.push("bytes-uploaded")
            const aborted = await rejection(() =>
              Storage.transaction(async () => {
                await WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
                throw new Error("Injected metadata transaction interruption")
              }),
            )
            const rolledBack = await WorkspaceCatalog.get(workspace.id, "home")
            const afterRollback = await WorkspaceContent.read(selection, "record.txt")
            if (aborted?.message === "Injected metadata transaction interruption") barriers.push("metadata-interrupted")
            timeline.push({ stage: "metadata-rolled-back", at: Date.now(), manifest: rolledBack.content!.manifest! })
            if (digest(before) === digest(oldBytes) && digest(afterRollback) === digest(oldBytes))
              barriers.push("read-checked")
            const lost = await rejection(async () => {
              await WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
              throw new Error("Injected loss after metadata commit")
            })
            timeline.push({ stage: "commit-response-lost", at: Date.now(), manifest: prepared.manifest })
            const retry = await rejection(() => WorkspaceCatalog.publishContent(prepared.info, prepared.manifest))
            const recovered = await WorkspaceCatalog.get(workspace.id, "home")
            const after = await WorkspaceContent.read(selection, "record.txt")
            const consistent =
              lost !== null &&
              retry !== null &&
              recovered.content?.manifest === prepared.manifest &&
              recovered.content.revision === initial.content!.revision + 1 &&
              digest(after) === digest(newBytes)
            if (consistent) barriers.push("reconciled")
            observations = {
              halfPublishedReads: [before, afterRollback].filter((bytes) => digest(bytes) !== digest(oldBytes)).length,
              referencesConsistent: consistent,
            }
            physical = {
              uploadedButUnpublished: digest(uploadedBytes) === digest(newBytes) && digest(before) === digest(oldBytes),
              oldHash: digest(oldBytes),
              uploadedHash: digest(uploadedBytes),
              manifestHash: digest(uploadedManifest),
              staged,
              finalHash: digest(after),
              finalRevision: recovered.content?.revision,
            }
            product.push({ initial, rolledBack, recovered, aborted, lost, retry })
            transport = { timeline }
          } else {
            const checks = []
            const requests = []
            for (const protocol of ["s3", "oss"] as const) {
              const directory = path.join(context.directory, "objects", protocol)
              await using server = await endpoint(directory, protocol)
              const credential = await SecretVault.register(
                JSON.stringify({ accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" }),
                { kind: "user" },
              )
              await Config.updateGlobal({
                resources: {
                  stores: {
                    [protocol]: {
                      provider: protocol,
                      spec: {
                        endpoint: server.url,
                        bucket: "acceptance-fixture",
                        region: protocol === "s3" ? "us-east-1" : "oss-cn-hangzhou",
                        prefix: "workspace",
                        credentialsRef: credential.id,
                        ...(protocol === "oss" ? { cname: true } : {}),
                      },
                    },
                  },
                },
              })
              const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: protocol })
              const selection = { scopeID: "home", workspaceID: workspace.id }
              const bytes = Buffer.from(crypto.randomUUID())
              const initial = await WorkspaceContent.write(selection, {
                path: "record.txt",
                data: bytes,
                expectedVersion: null,
              })
              const read = await WorkspaceContent.read(selection, "record.txt")
              const stored = new Uint8Array(await Bun.file(path.join(directory, digest(bytes))).arrayBuffer())
              server.fault("deny-put")
              const upload = await rejection(() =>
                WorkspaceContent.write(selection, {
                  path: "new.txt",
                  data: Buffer.from(crypto.randomUUID()),
                  expectedVersion: null,
                }),
              )
              const afterUpload = await WorkspaceCatalog.get(workspace.id, "home")
              server.fault("missing")
              const missing = await rejection(() => WorkspaceContent.read(selection, "record.txt"))
              server.fault("corrupt")
              const corrupt = await rejection(() => WorkspaceContent.read(selection, "record.txt"))
              server.fault("truncate")
              const truncated = await rejection(() => WorkspaceContent.read(selection, "record.txt"))
              server.fault("none")
              const continued = await WorkspaceContent.read(selection, "record.txt")
              const manifest = WorkspaceTree.Manifest.parse(
                await Bun.file(path.join(directory, initial.content!.manifest!)).json(),
              )
              const check = {
                protocol,
                unchanged: JSON.stringify(initial.content) === JSON.stringify(afterUpload.content),
                matches: [read, stored, continued].every((value) => digest(value) === digest(bytes)),
                corruptRejected: corrupt?.message.includes("integrity") === true,
                truncatedRejected: truncated !== null,
                attributable:
                  upload !== null &&
                  missing !== null &&
                  /AccessDenied|403/.test(JSON.stringify(upload)) &&
                  /NoSuchKey|404/.test(JSON.stringify(missing)),
                signed: server.requests.length > 0 && server.requests.every((request) => request.signed),
                hash: digest(stored),
                manifest,
              }
              checks.push(check)
              product.push({ protocol, initial, afterUpload, upload, missing, corrupt, truncated })
              requests.push(...server.requests)
              if (check.matches && check.signed && check.truncatedRejected) barriers.push(`${protocol}-checked`)
            }
            if (checks.every((check) => check.corruptRejected)) barriers.push("hash-corrupted")
            if (checks.every((check) => check.attributable && check.unchanged)) barriers.push("upload-failed")
            observations = {
              halfPublished: checks.filter((check) => !check.unchanged).length,
              corruptReads: checks.filter((check) => !check.corruptRejected || !check.truncatedRejected).length,
              providerErrorsPreserved: checks.every((check) => check.attributable),
            }
            physical = { checks }
            transport = { requests }
          }
          await Promise.all([
            atomicJSON(path.join(context.directory, "observations.json"), observations),
            atomicJSON(path.join(context.directory, "product.json"), product),
            atomicJSON(path.join(context.directory, "physical.json"), physical),
            atomicJSON(path.join(context.directory, "transport.json"), transport),
          ])
          return {
            status: "passed",
            model: "not-applicable",
            barriers,
            requests: [],
            evidence: await Promise.all([
              sealEvidence(context.directory, "observations.json", "product"),
              sealEvidence(context.directory, "product.json", "product"),
              sealEvidence(context.directory, "physical.json", "external"),
              sealEvidence(context.directory, "transport.json", "transport"),
            ]),
          }
        },
      }),
    )
  }
}
