import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationResourceProtocol {
  export const Scope = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("organization") }),
    z.strictObject({ kind: z.literal("project"), projectID: Identity.ID }),
  ])
  export type Scope = z.infer<typeof Scope>
  export const SubjectKind = z.enum(["account", "project"])
  export const Subject = z.strictObject({ kind: SubjectKind, id: Identity.ID })
  export type Subject = z.infer<typeof Subject>
  const Modality = z.enum(["text", "image", "audio", "video", "pdf"])
  export const Model = z.strictObject({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s\u0000-\u001f\u007f]+$/),
    name: Identity.Name,
    limit: z.strictObject({
      context: z.number().int().positive(),
      input: z.number().int().positive().optional(),
      output: z.number().int().positive(),
    }),
    capabilities: z
      .strictObject({
        temperature: z.boolean().default(true),
        reasoning: z.boolean().default(false),
        tools: z.boolean().default(true),
        input: z.array(Modality).min(1).default(["text"]),
        output: z.array(Modality).min(1).default(["text"]),
        interleaved: z.union([z.literal(false), z.enum(["reasoning_content", "reasoning_details"])]).default(false),
        reasoningEfforts: z.array(z.string().min(1).max(64)).optional(),
      })
      .prefault({}),
  })
  const ModelDefinition = z.strictObject({
    protocol: z.enum(["openai-compatible", "anthropic-compatible"]),
    model: Model,
  })
  const MCPDefinition = z.strictObject({ protocol: z.enum(["mcp-http", "mcp-sse"]) })
  const HTTPDefinition = z.strictObject({
    protocol: z.literal("fixed-http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  })
  const WorkspaceDefinition = z.strictObject({ protocol: z.literal("workspace-storage") })
  const EnvironmentDefinition = z.strictObject({ protocol: z.literal("environment") })
  export const Definition = z.discriminatedUnion("protocol", [ModelDefinition, MCPDefinition, HTTPDefinition, WorkspaceDefinition, EnvironmentDefinition])
  export type Definition = z.infer<typeof Definition>
  export function kind(definition: Definition) {
    if (definition.protocol === "workspace-storage") return "workspace" as const
    if (definition.protocol === "environment") return "environment" as const
    return definition.protocol === "openai-compatible" || definition.protocol === "anthropic-compatible"
      ? ("model" as const)
      : ("connection" as const)
  }
  export const Endpoint = z
    .string()
    .min(1)
    .max(4096)
    .url()
    .refine((value) => {
      try {
        const url = new URL(value)
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      } catch {
        return false
      }
    }, "Resource endpoint must be an HTTP URL without embedded credentials, query or fragment")
  export const Configuration = z.discriminatedUnion("protocol", [
    ModelDefinition.extend({ endpoint: Endpoint }),
    MCPDefinition.extend({ endpoint: Endpoint }),
    HTTPDefinition.extend({ endpoint: Endpoint }),
    WorkspaceDefinition.extend({ profile: Identity.Name }),
    EnvironmentDefinition.extend({ profile: Identity.Name }),
  ])
  export type Configuration = z.infer<typeof Configuration>
  export function definition(configuration: Configuration): Definition {
    return Definition.parse(configuration.protocol === "workspace-storage" || configuration.protocol === "environment"
      ? { protocol: configuration.protocol }
      : "model" in configuration
        ? { protocol: configuration.protocol, model: configuration.model }
        : configuration.protocol === "fixed-http"
          ? { protocol: configuration.protocol, method: configuration.method }
          : { protocol: configuration.protocol })
  }
  const Header = z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
    .refine(
      (name) =>
        ![
          "authorization",
          "cookie",
          "set-cookie",
          "host",
          "connection",
          "content-length",
          "content-type",
          "content-encoding",
          "accept",
          "transfer-encoding",
          "proxy-authorization",
          "proxy-connection",
          "upgrade",
          "te",
          "trailer",
          "origin",
          "referer",
        ].includes(name.toLowerCase()),
      "This header cannot carry a resource credential",
    )
  export const CredentialInfo = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("bearer") }),
    z.strictObject({ kind: z.literal("header"), name: Header }),
  ])
  const Secret = z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x20-\x7e]+$/)
  export const Credential = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("bearer"), value: Secret }),
    z.strictObject({ kind: z.literal("header"), name: Header, value: Secret }),
  ])
  export type Credential = z.infer<typeof Credential>
  export const Metadata = z.strictObject({
    resourceID: Identity.ID,
    orgID: Identity.ID,
    scope: Scope,
    kind: z.enum(["model", "connection", "workspace", "environment"]),
    name: Identity.Name,
    state: z.enum(["enabled", "disabled"]),
    revision: Identity.Revision,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  export const AdminView = Metadata.extend({
    configuration: Configuration,
    credential: CredentialInfo,
  })
    .refine((value) => value.kind === kind(value.configuration), "Resource kind must match its configuration")
    .meta({ ref: "OrgResourceAdminView" })
  export type AdminView = z.infer<typeof AdminView>
  export const View = Metadata.extend({
    definition: Definition,
    permissions: z.strictObject({ use: z.boolean() }),
  })
    .refine((value) => value.kind === kind(value.definition), "Resource kind must match its definition")
    .meta({ ref: "OrgResourceView" })
  export type View = z.infer<typeof View>
  export const Create = z
    .strictObject({
      name: Identity.Name,
      scope: Scope,
      configuration: Configuration,
      credential: Credential,
    })
    .meta({ ref: "OrgResourceCreate" })
  export type Create = z.infer<typeof Create>
  export const Change = z
    .strictObject({
      expectedRevision: Identity.Revision,
      name: Identity.Name.optional(),
      state: z.enum(["enabled", "disabled"]).optional(),
      configuration: Configuration.optional(),
      credential: Credential.optional(),
    })
    .refine(
      (value) =>
        value.name !== undefined ||
        value.state !== undefined ||
        value.configuration !== undefined ||
        value.credential !== undefined,
      "No change supplied",
    )
    .meta({ ref: "OrgResourceChange" })
  export type Change = z.infer<typeof Change>
  export const Grant = z
    .strictObject({
      orgID: Identity.ID,
      resourceID: Identity.ID,
      subject: Subject,
      enabled: z.boolean(),
      revision: Identity.Revision,
      updatedAt: z.number().int().nonnegative(),
      updatedBy: Identity.ID,
    })
    .meta({ ref: "OrgResourceGrant" })
  export type Grant = z.infer<typeof Grant>
  export const GrantChange = z
    .strictObject({
      expectedRevision: Identity.Revision,
      enabled: z.boolean(),
    })
    .meta({ ref: "OrgResourceGrantChange" })
  export type GrantChange = z.infer<typeof GrantChange>
  export const Page = z
    .strictObject({ items: z.array(View), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgResourcePage" })
  export const AdminPage = z
    .strictObject({ items: z.array(AdminView), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgResourceAdminPage" })
  export const GrantPage = z
    .strictObject({ items: z.array(Grant), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgResourceGrantPage" })
}
