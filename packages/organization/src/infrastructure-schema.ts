import path from "node:path"
import { z } from "zod"
import { DockerEnvironmentSpec } from "@ericsanchezok/synergy-local-runtime/environment/docker"

const PrivateFile = z.string().min(1).refine(path.isAbsolute, "Credential files must have absolute paths")
const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const Endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
  }, "Infrastructure endpoints must not contain credentials or query parameters")
const TLSFiles = z.strictObject({ certFile: PrivateFile, keyFile: PrivateFile, caFile: PrivateFile.optional() })
const Store = z.strictObject({
  provider: z.enum(["s3", "oss"]),
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: Endpoint.optional(),
  prefix: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/)
    .optional(),
  credentialsFile: PrivateFile,
})
const Docker = z.strictObject({
  provider: z.literal("docker"),
  spec: DockerEnvironmentSpec,
  host: z.strictObject({
    endpoint: Endpoint.refine((value) => {
      const url = new URL(value)
      return (
        url.protocol === "unix:" ||
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      )
    }, "Docker requires Unix, HTTPS or loopback HTTP"),
    engineTLS: TLSFiles.optional(),
    executionTLS: TLSFiles.optional(),
    executionHostname: z.string().min(1).optional(),
    publishHostIP: z.string().min(1).optional(),
  }),
  idleTimeoutMs: z.number().int().nonnegative().optional(),
})

export const InfrastructureConfiguration = z.strictObject({
  version: z.literal(1),
  database: z
    .strictObject({
      backend: z.literal("postgres"),
      urlFile: PrivateFile,
      namespace: Name,
      maxConnections: z.number().int().min(1).max(32).default(2),
    })
    .optional(),
  stores: z.record(Name, Store).optional(),
  environments: z.record(Name, Docker).optional(),
})
export type InfrastructureConfiguration = z.infer<typeof InfrastructureConfiguration>
