import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { s3BlobStore, ossBlobStore } from "@ericsanchezok/synergy-local-runtime/workspace/blob-store"
import { dockerEnvironment } from "@ericsanchezok/synergy-local-runtime/environment/docker"
import { InfrastructureConfiguration } from "./infrastructure-schema"
import { readOrganizationPrivateFile } from "./private-file"
import type { OrganizationServiceOptions } from "./service"

export const OrganizationInfrastructureError = NamedError.create(
  "OrganizationInfrastructureError",
  z.object({
    reason: z.enum(["credential_file", "credential_content", "database_url", "composition"]),
  }),
)
const Credentials = z.strictObject({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
})

async function privateFile(filename: string) {
  try {
    return (await readOrganizationPrivateFile(filename)).trim()
  } catch {
    throw new OrganizationInfrastructureError({ reason: "credential_file" })
  }
}

async function tls(files: { certFile: string; keyFile: string; caFile?: string } | undefined) {
  if (!files) return
  const [cert, key, ca] = await Promise.all([
    privateFile(files.certFile),
    privateFile(files.keyFile),
    files.caFile ? privateFile(files.caFile) : undefined,
  ])
  return { cert, key, ca }
}

export async function loadOrganizationInfrastructure(
  input: InfrastructureConfiguration | undefined,
): Promise<Pick<OrganizationServiceOptions, "database" | "cloud">> {
  if (!input) return {}
  const configuration = InfrastructureConfiguration.parse(input)
  let database: OrganizationServiceOptions["database"]
  if (configuration.database) {
    const url = await privateFile(configuration.database.urlFile)
    try {
      const parsed = new URL(url)
      if (
        !["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        !parsed.pathname.slice(1) ||
        parsed.hash
      )
        throw new Error()
    } catch {
      throw new OrganizationInfrastructureError({ reason: "database_url" })
    }
    database = {
      backend: "postgres",
      namespace: configuration.database.namespace,
      maxConnections: configuration.database.maxConnections,
      url,
    }
  }
  const stores = await Promise.all(
    Object.entries(configuration.stores ?? {}).map(async ([id, { provider, credentialsFile, ...options }]) => {
      const text = await privateFile(credentialsFile)
      let credentials: z.infer<typeof Credentials>
      try {
        credentials = Credentials.parse(JSON.parse(text))
      } catch {
        throw new OrganizationInfrastructureError({ reason: "credential_content" })
      }
      try {
        return [
          id,
          (provider === "s3" ? s3BlobStore : ossBlobStore)({ ...options, credentials: async () => credentials }),
        ] as const
      } catch {
        throw new OrganizationInfrastructureError({ reason: "composition" })
      }
    }),
  )
  const environments = await Promise.all(
    Object.entries(configuration.environments ?? {}).map(async ([name, profile]) => {
      const [engineTLS, executionTLS] = await Promise.all([tls(profile.host.engineTLS), tls(profile.host.executionTLS)])
      try {
        const provider = dockerEnvironment({
          id: `organization-docker-${name}`,
          ...profile.host,
          engineTLS,
          executionTLS,
        })
        return {
          name,
          provider,
          profile: { provider: provider.id, spec: profile.spec, idleTimeoutMs: profile.idleTimeoutMs },
        }
      } catch {
        throw new OrganizationInfrastructureError({ reason: "composition" })
      }
    }),
  )
  return {
    database,
    cloud: {
      blobStores: Object.fromEntries(stores),
      workspaceProfiles: Object.fromEntries(stores.map(([id]) => [id, { blobStore: id }])),
      environmentProviders: environments.map(({ provider }) => provider),
      environmentProfiles: Object.fromEntries(environments.map(({ name, profile }) => [name, profile])),
    },
  }
}
