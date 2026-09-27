import { z } from "zod"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import {
  EnvironmentProviders,
  type EnvironmentProvider,
  type EnvironmentRequest,
} from "@ericsanchezok/synergy-harness/environment/provider"
import { WorkspaceBlobs, type BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { dockerEnvironment } from "./docker"
import { s3BlobStore, ossBlobStore } from "../workspace/blob-store"
import {
  DockerProfileSpec,
  EnvironmentProfile,
  LocalStoreSpec,
  ObjectStoreSpec,
  ResourcesConfig,
  StoreProfile,
} from "./profile-schema"

export namespace ResourceProfiles {
  const native = { provider: "native", spec: {}, reuse: "scope" } as const
  const Credentials = z
    .object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().optional() })
    .strict()

  async function config() {
    return ResourcesConfig.parse((await Config.global()).resources) ?? {}
  }
  async function secret(id: string) {
    const value = await SecretVault.reveal(id)
    if (!value) throw new Error("Resource credential is unavailable")
    return value
  }
  async function tls(input: z.infer<typeof DockerProfileSpec>["host"]["executionTLS"]) {
    if (!input) return undefined
    const [cert, key, ca] = await Promise.all([
      secret(input.certRef),
      secret(input.keyRef),
      input.caRef ? secret(input.caRef) : undefined,
    ])
    return { cert, key, ca }
  }

  export const Summary = z
    .object({
      defaultEnvironment: z.string().nullable(),
      environments: z.array(
        z.object({ name: z.string(), provider: z.string(), reuse: z.enum(["session", "workspace", "scope"]) }),
      ),
      stores: z.array(z.object({ name: z.string(), provider: z.string() })),
    })
    .meta({ ref: "ResourceProfiles" })

  export async function list(): Promise<z.infer<typeof Summary>> {
    const settings = await config()
    return {
      defaultEnvironment: settings.defaultEnvironment === undefined ? "native" : settings.defaultEnvironment,
      environments: Object.entries({ native, ...settings.environments }).map(([name, profile]) => ({
        name,
        provider: profile.provider,
        reuse: profile.reuse ?? "session",
      })),
      stores: Object.entries(settings.stores ?? {}).map(([name, profile]) => ({ name, provider: profile.provider })),
    }
  }

  async function environment(name: string): Promise<z.infer<typeof EnvironmentProfile>> {
    if (name === "native") return native
    const profile = (await config()).environments?.[name]
    if (!profile) throw new Storage.NotFoundError({ message: "Environment profile is unavailable" })
    return profile
  }

  export async function createEnvironment(input: { scopeID: string; ownerID: string; profile: string }) {
    const profile = await environment(input.profile)
    return Environment.bind({ ...input, ...profile })
  }

  export async function createWorkspace(input: { scopeID: string; profile: string; name?: string }) {
    const configured = (await config()).stores?.[input.profile]
    if (!configured) throw new Storage.NotFoundError({ message: "Workspace storage profile is unavailable" })
    const profile = StoreProfile.parse(configured)
    WorkspaceBlobs.get(profile.provider, profile.spec)
    return WorkspaceCatalog.create({
      scopeID: input.scopeID,
      backend: { provider: "objects", spec: { blobStore: profile.provider, settings: profile.spec } },
      metadata: { ...(input.name ? { name: input.name } : {}), profile: input.profile },
    })
  }

  function configuredDocker(): EnvironmentProvider {
    const delegate = async (request: EnvironmentRequest) => {
      const { host, ...spec } = DockerProfileSpec.parse(request.spec)
      const [engineTLS, executionTLS] = await Promise.all([tls(host.engineTLS), tls(host.executionTLS)])
      return { provider: dockerEnvironment({ ...host, engineTLS, executionTLS }), request: { ...request, spec } }
    }
    return {
      id: "docker",
      ownership: "managed",
      validateSpec: (spec) => DockerProfileSpec.parse(spec),
      async allocate(request) {
        const d = await delegate(request)
        return d.provider.allocate(d.request)
      },
      async inspect(request) {
        const d = await delegate(request)
        return d.provider.inspect(d.request)
      },
      async resume(request) {
        const d = await delegate(request)
        return d.provider.allocate(d.request)
      },
      async deallocate(request) {
        const d = await delegate(request)
        return d.provider.deallocate(d.request)
      },
      async connect(request, target) {
        const d = await delegate(request)
        return d.provider.connect!(d.request, target)
      },
    }
  }

  function localStore(settings: Record<string, unknown>): BlobStore {
    const spec = LocalStoreSpec.parse(settings)
    const filename = (hash: string) =>
      path.join(Global.Path.data, "workspace-objects", spec.namespace, WorkspaceTree.Hash.parse(hash).slice(0, 2), hash)
    return {
      async put(hash, bytes) {
        WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
        await AtomicFile.writeFileAtomic(filename(hash), bytes, { private: true, durable: true })
      },
      async get(hash, maximumBytes) {
        const file = Bun.file(filename(hash))
        if (file.size > maximumBytes) throw new Error("Workspace object exceeds the read limit")
        return WorkspaceTree.verify(hash, new Uint8Array(await file.arrayBuffer()), maximumBytes)
      },
    }
  }

  export function register() {
    EnvironmentProviders.register(configuredDocker())
    EnvironmentProviders.setDefaultResolver(async () => {
      const name = (await config()).defaultEnvironment
      return name === null ? undefined : environment(name ?? "native")
    })
    WorkspaceBlobs.registerFactory("local", localStore)
    for (const kind of ["s3", "oss"] as const)
      WorkspaceBlobs.registerFactory(kind, (settings) => {
        const spec = (
          kind === "oss" ? ObjectStoreSpec.extend({ cname: z.boolean().optional() }) : ObjectStoreSpec
        ).parse(settings)
        const credentials = async () => {
          const value = await secret(spec.credentialsRef)
          try {
            return Credentials.parse(JSON.parse(value))
          } catch {
            throw new Error("Resource credential is malformed")
          }
        }
        return (kind === "s3" ? s3BlobStore : ossBlobStore)({ ...spec, credentials })
      })
  }
}
