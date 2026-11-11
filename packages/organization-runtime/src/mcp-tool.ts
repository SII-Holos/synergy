import {
  OrganizationGatewayProtocol as Gateway,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { z } from "zod"
import type { RuntimeIdentity } from "./home"
import { denied, withMemberExecution } from "./execution-source"

const Parameters = z.discriminatedUnion("operation", [
  z.strictObject({ resourceID: z.string().min(1), operation: z.literal("list-tools") }),
  z.strictObject({
    resourceID: z.string().min(1),
    operation: z.literal("call-tool"),
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
])

const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024

export function createMemberMcpTool(identity: RuntimeIdentity): Tool.Info {
  return Tool.define(
    "organization_mcp",
    {
      description:
        "List tools or call one selected remote MCP connection. List tools before calling a remote tool; the service owns the endpoint and credential.",
      parameters: Parameters,
      async execute(input, ctx) {
        return withMemberExecution(
          identity,
          { sessionID: ctx.sessionID, signal: ctx.abort },
          async ({ source, description, proof }, signal) => {
            if (!description.grant.selection.connectionResourceIDs.includes(input.resourceID))
              throw denied("Organization MCP connection is not selected for this Session")
            const resource = description.resources.find((item) => item.resourceID === input.resourceID)
            if (!resource || Resource.kind(resource.definition) !== "connection")
              throw denied("Organization MCP connection resource is unavailable")
            if (resource.definition.protocol !== "mcp-http" && resource.definition.protocol !== "mcp-sse")
              throw denied("This organization connection requires its protocol adapter")
            const grant = await source.resources.bind(proof, signal)
            const now = Date.now()
            const capability = await source.resources.reserve(
              Gateway.Proof.parse({
                schemaVersion: 1,
                purpose: "gateway-call",
                orgID: grant.orgID,
                deploymentIncarnation: grant.deploymentIncarnation,
                runtimeID: grant.runtimeID,
                connectionEpoch: source.connection.connectionEpoch,
                grantID: grant.grantID,
                sessionID: grant.sessionID,
                rootID: grant.rootID,
                bindingEpoch: grant.bindingEpoch,
                resourceID: input.resourceID,
                callID: crypto.randomUUID(),
                issuedAt: now,
                expiresAt: now + 30_000,
              }),
              signal,
            )
            const operation: Gateway.McpRequest =
              input.operation === "list-tools"
                ? { operation: "list-tools" }
                : { operation: "call-tool", name: input.name, arguments: input.arguments }
            const result = await source.resources.invokeMcp(capability, operation, signal)
            const encoded = new TextEncoder().encode(JSON.stringify(result))
            const truncated = encoded.byteLength > MAX_TOOL_RESPONSE_BYTES
            const output = new TextDecoder().decode(truncated ? encoded.subarray(0, MAX_TOOL_RESPONSE_BYTES) : encoded)
            return {
              title: `${resource.name} · MCP ${input.operation}`,
              output,
              metadata: {
                resourceID: input.resourceID,
                operation: input.operation,
                truncated,
              },
            }
          },
        )
      },
    },
    { requiresWorkspace: false, exposure: { mode: "resident" } },
  )
}
