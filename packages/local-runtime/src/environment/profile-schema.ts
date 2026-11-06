import { z } from "zod"
import { DockerEnvironmentSpec } from "./docker"

const Reference = z.string().min(1).max(256)
const Endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
  }, "Endpoint must not contain credentials or query parameters")
const TLS = z.object({ certRef: Reference, keyRef: Reference, caRef: Reference.optional() }).strict()
export const DockerProfileSpec = DockerEnvironmentSpec.extend({
  host: z
    .object({
      endpoint: Endpoint.refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === "unix:" ||
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        )
      }, "Docker Engine requires Unix, HTTPS, or loopback HTTP"),
      engineTLS: TLS.optional(),
      executionHostname: z.string().min(1).optional(),
      publishHostIP: z.string().min(1).optional(),
      executionTLS: TLS.optional(),
    })
    .strict(),
})
  .strict()
  .refine((spec) => {
    const host = spec.host
    return (
      Boolean(host.executionTLS) ||
      ((!host.publishHostIP || host.publishHostIP === "127.0.0.1") &&
        (!host.executionHostname || ["127.0.0.1", "localhost", "::1"].includes(host.executionHostname)))
    )
  }, "Remote Docker execution requires TLS")

export const ObjectStoreSpec = z
  .object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    endpoint: Endpoint.optional(),
    prefix: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/)
      .optional(),
    credentialsRef: Reference.describe(
      "Secret Vault ID containing accessKeyId, secretAccessKey and optional sessionToken as JSON",
    ),
  })
  .strict()
export const LocalStoreSpec = z
  .object({
    namespace: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .default("default"),
  })
  .strict()
const Lifetime = {
  idleTimeoutMs: z.number().int().nonnegative().optional(),
  reuse: z.enum(["session", "workspace", "scope"]).optional(),
}
export const EnvironmentProfile = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("native"), spec: z.object({}).strict().default({}), ...Lifetime }).strict(),
  z.object({ provider: z.literal("docker"), spec: DockerProfileSpec, ...Lifetime }).strict(),
])
export const StoreProfile = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local"), spec: LocalStoreSpec }).strict(),
  z.object({ provider: z.literal("s3"), spec: ObjectStoreSpec }).strict(),
  z.object({ provider: z.literal("oss"), spec: ObjectStoreSpec.extend({ cname: z.boolean().optional() }) }).strict(),
])
const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
export const ResourcesConfig = z
  .object({
    defaultEnvironment: Name.nullable()
      .optional()
      .describe("Environment profile selected for new Sessions; null disables automatic selection"),
    environments: z
      .record(
        Name.refine((name) => name !== "native", "native is the built-in profile"),
        EnvironmentProfile,
      )
      .optional(),
    stores: z.record(Name, StoreProfile).optional(),
  })
  .strict()
  .optional()
  .meta({ ref: "ResourcesConfig" })
