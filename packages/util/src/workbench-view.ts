import { z } from "zod"
import { AssetReference } from "./asset-reference"
import { ResourceReference } from "./resource-reference"

export namespace WorkbenchView {
  export const VERSION = 1
  const identity = z.string().min(1)
  export const TargetKind = z.enum(["note", "workspace-file", "browser-page", "asset"])
  export type TargetKind = z.infer<typeof TargetKind>
  export const Target = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("note"), id: identity, location: ResourceReference.Location.optional() }).strict(),
    z
      .object({ kind: z.literal("workspace-file"), path: identity, location: ResourceReference.Location.optional() })
      .strict(),
    z.object({ kind: z.literal("browser-page"), pageId: identity }).strict(),
    z
      .object({
        kind: z.literal("asset"),
        url: identity.refine(
          (value) => AssetReference.parse(value)?.url === value,
          "Use an immutable asset:// reference.",
        ),
        location: ResourceReference.Location.optional(),
      })
      .strict(),
  ])
  export type Target = z.infer<typeof Target>
  export const Command = z.discriminatedUnion("action", [
    z.object({ action: z.literal("open"), target: Target }).strict(),
    z.object({ action: z.literal("hide"), viewId: identity }).strict(),
    z.object({ action: z.literal("status"), requestId: identity.optional() }).strict(),
  ])
  export type Command = z.infer<typeof Command>
  export const Parameters = z
    .object({
      input: Command,
      clientId: identity
        .optional()
        .describe("An eligible frontend ID returned by status when multiple frontends show this session."),
      timeoutSeconds: z
        .number()
        .positive()
        .finite()
        .optional()
        .describe("Seconds to wait for a frontend receipt. A missing receipt is unknown, not success."),
    })
    .strict()
  export type Parameters = z.infer<typeof Parameters>
  export const View = z
    .object({
      viewId: identity,
      surface: z.enum(["side", "bottom"]),
      target: Target,
      visible: z.boolean(),
      contentState: z.enum(["loading", "ready", "unavailable"]),
    })
    .strict()
  export type View = z.infer<typeof View>
  export const Client = z.object({ clientId: identity }).strict()
  export type Client = z.infer<typeof Client>
  export const Outcome = z
    .object({
      status: z.enum(["applied", "unavailable", "blocked", "superseded", "unknown", "ambiguous", "cancelled"]),
      reason: z.string().optional(),
      views: z.array(View).optional(),
      clients: z.array(Client).optional(),
    })
    .strict()
  export type Outcome = z.infer<typeof Outcome>
  export const Result = Outcome.extend({ requestId: identity, clientId: identity.optional() })
  export type Result = z.infer<typeof Result>
  export const Request = z
    .object({
      requestId: identity,
      scopeID: identity,
      sessionID: identity,
      command: Command,
      context: ResourceReference.Context.optional(),
    })
    .strict()
  export type Request = z.infer<typeof Request>
  export const ServerMessage = z.discriminatedUnion("type", [
    z.object({ type: z.literal("server.workbench.request"), properties: Request }).strict(),
    z
      .object({ type: z.literal("server.workbench.cancel"), properties: z.object({ requestId: identity }).strict() })
      .strict(),
  ])
  export type ServerMessage = z.infer<typeof ServerMessage>
  export const ClientMessage = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("client.workbench.ready"),
        properties: z.object({ version: z.literal(VERSION), targets: z.array(TargetKind) }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("client.workbench.receipt"),
        properties: z.object({ requestId: identity, outcome: Outcome }).strict(),
      })
      .strict(),
  ])
  export type ClientMessage = z.infer<typeof ClientMessage>
}
