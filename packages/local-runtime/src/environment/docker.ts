import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import path from "node:path"
import {
  EnvironmentProviders,
  type EnvironmentProvider,
  type EnvironmentRequest,
} from "@ericsanchezok/synergy-harness/environment/provider"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { DockerEngine, DockerContainer } from "./docker-engine"
import { RemoteExecutor } from "./remote-executor"

export const DockerEnvironmentSpec = z
  .object({
    image: z.string().min(1),
    memoryBytes: z
      .number()
      .int()
      .min(64 * 1024 * 1024)
      .default(1024 * 1024 * 1024),
    cpus: z.number().positive().max(256).default(1),
    pids: z.number().int().min(16).max(65536).default(256),
    mounts: z
      .array(
        z
          .object({
            type: z.enum(["bind", "volume"]),
            source: z.string().min(1),
            target: z
              .string()
              .startsWith("/")
              .refine(
                (value) => path.posix.normalize(value) === value && !value.includes("\0"),
                "Mount target must be a normalized absolute path",
              ),
            readOnly: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()

export interface DockerEnvironmentOptions {
  id?: string
  endpoint: string
  engineTLS?: Bun.TLSOptions
  executionHostname?: string
  publishHostIP?: string
  executionTLS?: { cert: string; key: string; ca?: string }
}

export function dockerEnvironment(options: DockerEnvironmentOptions): EnvironmentProvider {
  const engine = new DockerEngine({ endpoint: options.endpoint, tls: options.engineTLS })
  const providerID = options.id ?? "docker"
  const hostname = options.executionHostname ?? "127.0.0.1"
  const publishHostIP = options.publishHostIP ?? "127.0.0.1"
  if ((publishHostIP !== "127.0.0.1" || !["127.0.0.1", "localhost", "::1"].includes(hostname)) && !options.executionTLS)
    throw new Error("Remote Docker execution requires TLS")
  const name = (request: EnvironmentRequest) =>
    `synergy-env-${createHash("sha256").update(request.requestID).digest("hex").slice(0, 24)}`
  const labels = (request: EnvironmentRequest) => ({
    "io.synergy.environment": request.environmentID,
    "io.synergy.allocation": request.requestID,
    "io.synergy.generation": String(request.generation),
  })
  const assertOwned = (request: EnvironmentRequest, container: z.infer<typeof DockerContainer>) => {
    if (Object.entries(labels(request)).some(([key, value]) => container.Config.Labels?.[key] !== value))
      throw new Error("Docker container belongs to another allocation")
  }
  async function inspectNetwork(request: EnvironmentRequest) {
    const response = await engine.request("GET", `/networks/${name(request)}`, undefined, [404])
    if (response.status === 404) return false
    const info = z.object({ Labels: z.record(z.string(), z.string()).nullable() }).parse(await response.json())
    if (Object.entries(labels(request)).some(([key, value]) => info.Labels?.[key] !== value))
      throw new Error("Docker network belongs to another allocation")
    return true
  }
  async function inspectVolume(request: EnvironmentRequest) {
    const response = await engine.request("GET", `/volumes/${name(request)}-files`, undefined, [404])
    if (response.status === 404) return false
    const info = z.object({ Labels: z.record(z.string(), z.string()).nullable() }).parse(await response.json())
    if (Object.entries(labels(request)).some(([key, value]) => info.Labels?.[key] !== value))
      throw new Error("Docker staging volume belongs to another allocation")
    return true
  }
  const allocation = (request: EnvironmentRequest) => ({
    id: request.requestID,
    capabilities: ["exec", "pty", "files"],
  })
  async function verifyIncarnation(request: EnvironmentRequest, container: z.infer<typeof DockerContainer>) {
    const receipt = { id: container.Id, startedAt: container.State.StartedAt }
    await Storage.transaction(async () => {
      const key = StoragePath.environmentAllocationReceipt(providerID, request.requestID)
      const [previous] = await Storage.readMany<typeof receipt>([key])
      if (previous && (previous.id !== receipt.id || previous.startedAt !== receipt.startedAt))
        throw new Error("Docker allocation restarted; reconcile outstanding work before replacing it")
      if (!previous) await Storage.write(key, receipt)
    })
  }
  async function credential(request: EnvironmentRequest, create = false) {
    const key = StoragePath.environmentCredential(providerID, request.requestID)
    const [id] = await Storage.readMany<string>([key])
    if (id) {
      const value = await SecretVault.reveal(id)
      if (!value) throw new Error("Execution Host credential is unavailable")
      return value
    }
    if (!create) throw new Error("Execution Host credential is unavailable")
    const entry = await SecretVault.register(
      randomBytes(32).toString("hex"),
      { kind: "user" },
      { policy: { tools: [] } },
    )
    await Storage.write(key, entry.id)
    return entry.value
  }
  async function remote(request: EnvironmentRequest, container: z.infer<typeof DockerContainer>) {
    assertOwned(request, container)
    await verifyIncarnation(request, container)
    const port = container.NetworkSettings.Ports["7443/tcp"]?.find(
      (binding) => binding.HostIp === publishHostIP,
    )?.HostPort
    if (!port) throw new Error("Docker execution endpoint is unavailable")
    const address = hostname.includes(":") ? `[${hostname}]` : hostname
    return new RemoteExecutor({
      url: `${options.executionTLS ? "https" : "http"}://${address}:${port}`,
      target: { environmentID: request.environmentID, allocationID: request.requestID, generation: request.generation },
      token: await credential(request),
      tls: options.executionTLS ? { ca: options.executionTLS.ca ?? options.executionTLS.cert } : undefined,
    })
  }
  const provider: EnvironmentProvider = {
    id: providerID,
    ownership: "managed",
    validateSpec: (spec) => DockerEnvironmentSpec.parse(spec),
    async allocate(request) {
      const spec = DockerEnvironmentSpec.parse(request.spec)
      for (const mount of spec.mounts) {
        if (
          mount.target === "/" ||
          ["/proc", "/sys", "/dev", "/opt/synergy", "/var/lib/synergy-executor", "/workspaces"].some(
            (root) => mount.target === root || mount.target.startsWith(root + "/"),
          )
        )
          throw new Error("Workspace mounts cannot replace Execution Host resources")
      }
      const token = await credential(request, true)
      let container = await engine.inspect(name(request))
      if (!container) {
        await engine.request("POST", "/volumes/create", { Name: `${name(request)}-files`, Labels: labels(request) })
        await inspectVolume(request)
        const network = await engine.request(
          "POST",
          "/networks/create",
          { Name: name(request), CheckDuplicate: true, Labels: labels(request), Driver: "bridge" },
          [409],
        )
        if (!network.ok && network.status !== 409) throw new Error("Docker Environment network is unavailable")
        await inspectNetwork(request)
        const response = await engine.request(
          "POST",
          `/containers/create?name=${encodeURIComponent(name(request))}`,
          {
            Image: spec.image,
            Labels: labels(request),
            Env: [
              `SYNERGY_EXECUTION_TARGET=${JSON.stringify({ environmentID: request.environmentID, allocationID: request.requestID, generation: request.generation })}`,
              `SYNERGY_EXECUTION_TOKEN=${token}`,
              `SYNERGY_WORKSPACE_ROOTS=${JSON.stringify(spec.mounts.map((mount) => mount.target))}`,
              ...(options.executionTLS
                ? [
                    `SYNERGY_EXECUTION_CERT=${options.executionTLS.cert}`,
                    `SYNERGY_EXECUTION_KEY=${options.executionTLS.key}`,
                  ]
                : []),
            ],
            ExposedPorts: { "7443/tcp": {} },
            HostConfig: {
              NetworkMode: name(request),
              ReadonlyRootfs: true,
              CapDrop: ["ALL"],
              CapAdd: ["SETUID", "SETGID", "KILL", "CHOWN", "FOWNER", "DAC_OVERRIDE"],
              SecurityOpt: ["no-new-privileges:true"],
              Memory: spec.memoryBytes,
              NanoCpus: Math.round(spec.cpus * 1e9),
              PidsLimit: spec.pids,
              Tmpfs: {
                "/tmp": "rw,nosuid,nodev,size=256m",
                "/var/lib/synergy-executor": "rw,nosuid,nodev,noexec,mode=0700,size=512m",
              },
              PortBindings: { "7443/tcp": [{ HostIp: publishHostIP, HostPort: "" }] },
              Mounts: [
                { Type: "volume", Source: `${name(request)}-files`, Target: "/workspaces", ReadOnly: false },
                ...spec.mounts.map((mount) => ({
                  Type: mount.type,
                  Source: mount.source,
                  Target: mount.target,
                  ReadOnly: mount.readOnly,
                })),
              ],
            },
          },
          [409],
        )
        if (!response.ok && response.status !== 409) throw new Error("Docker Environment allocation failed")
        container = await engine.inspect(name(request))
      }
      if (!container) throw new Error("Docker Environment allocation is uncertain")
      assertOwned(request, container)
      if (!container.State.Running) await engine.request("POST", `/containers/${container.Id}/start`, undefined, [304])
      for (let attempt = 0; attempt < 200; attempt++) {
        const running = await engine.inspect(name(request))
        if (!running?.State.Running) throw new Error("Docker Execution Host stopped during startup")
        const client = await remote(request, running)
        try {
          await client.health()
          return allocation(request)
        } catch {
          await Bun.sleep(50)
        }
      }
      throw new Error("Docker Execution Host readiness timed out")
    },
    async inspect(request) {
      const container = await engine.inspect(name(request))
      if (!container)
        return { state: (await inspectVolume(request)) || (await inspectNetwork(request)) ? "pending" : "absent" }
      assertOwned(request, container)
      if (container.State.Status === "created") return { state: "pending" }
      if (!container.State.Running) return { state: "unknown" }
      try {
        await (await remote(request, container)).health()
      } catch {
        return { state: "unknown" }
      }
      return { state: "ready", allocation: allocation(request) }
    },
    resume: (request) => provider.allocate(request),
    async connect(request, target) {
      if (
        !Environment.sameTarget(target, {
          environmentID: request.environmentID,
          allocationID: request.requestID,
          generation: request.generation,
        })
      )
        throw new Error("Docker allocation changed")
      const container = await engine.inspect(name(request))
      if (!container?.State.Running) throw new Error("Docker Environment is unavailable")
      return remote(request, container)
    },
    async deallocate(request) {
      const container = await engine.inspect(name(request))
      if (container) {
        assertOwned(request, container)
        await engine.request("DELETE", `/containers/${container.Id}?force=true&v=false`, undefined, [404])
        if (await engine.inspect(name(request))) throw new Error("Docker Environment termination is unconfirmed")
      }
      if (await inspectNetwork(request)) await engine.request("DELETE", `/networks/${name(request)}`, undefined, [404])
      if (await inspectVolume(request))
        await engine.request("DELETE", `/volumes/${name(request)}-files`, undefined, [404])
      const key = StoragePath.environmentCredential(providerID, request.requestID)
      const [id] = await Storage.readMany<string>([key])
      if (id) await SecretVault.remove(id)
      await Storage.remove(key)
      await Storage.remove(StoragePath.environmentAllocationReceipt(providerID, request.requestID))
    },
  }
  return provider
}

export function registerDockerEnvironment(options: DockerEnvironmentOptions) {
  EnvironmentProviders.register(dockerEnvironment(options))
}
