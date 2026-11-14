import {
  OrganizationGatewayProtocol as Gateway,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { z } from "zod"
import type { RuntimeIdentity } from "./home"
import { denied, withMemberExecution } from "./execution-source"

const Parameters = z.strictObject({
  resourceID: z.string().min(1),
  body: z.unknown().optional(),
})

const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024

async function readBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) return { output: "", truncated: false }
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      const remaining = MAX_TOOL_RESPONSE_BYTES - bytes
      if (remaining <= 0) {
        truncated = true
        await reader.cancel()
        break
      }
      const chunk = item.value.byteLength > remaining ? item.value.subarray(0, remaining) : item.value
      chunks.push(chunk)
      bytes += chunk.byteLength
      if (chunk.byteLength < item.value.byteLength) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    return { output: decoder.decode(Buffer.concat(chunks, bytes)), truncated }
  } finally {
    reader.releaseLock()
  }
}

export function createMemberConnectionTool(identity: RuntimeIdentity): Tool.Info {
  return Tool.define(
    "organization_connection",
    {
      description:
        "Invoke one fixed HTTP business connection selected for the current organization Session. Use the selected resource ID; the service owns the endpoint and credential.",
      parameters: Parameters,
      async execute(input, ctx) {
        return withMemberExecution(
          identity,
          { sessionID: ctx.sessionID, signal: ctx.abort },
          async ({ source, description, proof }, signal) => {
            if (!description.grant.selection.connectionResourceIDs.includes(input.resourceID))
              throw denied("Organization connection is not selected for this Session")
            const resource = description.resources.find((item) => item.resourceID === input.resourceID)
            if (!resource || Resource.kind(resource.definition) !== "connection")
              throw denied("Organization connection resource is unavailable")
            if (resource.definition.protocol !== "fixed-http")
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
            const body = input.body === undefined ? undefined : JSON.stringify(input.body)
            const response = await source.resources.invoke(capability, { body, signal })
            const content = await readBody(response, signal)
            return {
              title: `${resource.name} · HTTP ${response.status}`,
              output: content.output || `(HTTP ${response.status})`,
              metadata: {
                resourceID: input.resourceID,
                status: response.status,
                contentType: response.headers.get("content-type"),
                truncated: content.truncated,
              },
            }
          },
        )
      },
    },
    { requiresWorkspace: false, exposure: { mode: "resident" } },
  )
}
