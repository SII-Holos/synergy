import { z } from "zod"
import { ScopeContext } from "../scope/context"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { RolloutArtifact } from "./rollout/artifact"
import { RolloutLedger } from "./rollout/ledger"
import { TurnExecutionState } from "./turn-execution-state"
import { Storage } from "../storage/storage"
import { PermissionNext } from "../permission/next"
import { ProcessRegistry } from "../process/registry"
import { SecretMask } from "../secrets/mask"

export namespace SessionActivity {
  export const Result = z
    .object({
      part: MessageV2.ToolPart,
      text: z.string().optional(),
      evidenceMissing: z.boolean(),
      truncated: z.boolean().optional(),
      process: z
        .object({
          status: z.enum(["running", "completed", "interrupted", "failed"]),
          exitCode: z.number().nullable().optional(),
          signal: z.string().nullable().optional(),
          endedAt: z.number().optional(),
        })
        .optional(),
    })
    .meta({ ref: "ToolActivityResult" })
  export type Result = z.infer<typeof Result>

  async function owner(sessionID: string) {
    const session = await Session.get(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Storage.NotFoundError({ message: "Session activity not found" })
    return { kind: "session" as const, scopeID: session.scope.id, sessionID }
  }

  export async function turns(sessionID: string, rootIDs: string[]) {
    const selected = await owner(sessionID)
    const roots = [...new Set(rootIDs)].slice(0, 64)
    const result: TurnExecutionState.Info[] = []
    const approvals = await PermissionNext.list()
    const pendingRoots = new Set<string>()
    for (const approval of approvals) {
      if (approval.sessionID !== sessionID || !approval.tool) continue
      const message = await MessageV2.get({
        scopeID: selected.scopeID,
        sessionID,
        messageID: approval.tool.messageID,
      }).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (message?.info.role === "assistant") pendingRoots.add(message.info.rootID ?? message.info.parentID)
    }
    for (const rootID of roots) {
      try {
        const run = await RolloutLedger.getRun(selected, rootID)
        result.push(
          TurnExecutionState.project(run, await RolloutLedger.segments(selected, rootID), pendingRoots.has(rootID)),
        )
      } catch (error) {
        if (!(error instanceof Storage.NotFoundError)) throw error
      }
    }
    return result
  }

  export async function tool(input: {
    sessionID: string
    messageID: string
    partID: string
    callID?: string
  }): Promise<Result> {
    const selected = await owner(input.sessionID)
    const message = await MessageV2.get({
      scopeID: selected.scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
    })
    const part = message.parts.find((part) => part.id === input.partID)
    if (!part || part.type !== "tool" || (input.callID && input.callID !== part.callID))
      throw new Storage.NotFoundError({ message: "Tool activity not found" })
    if (message.info.role === "assistant" && part.tool === "bash") {
      const rootID = message.info.rootID ?? message.info.parentID
      const execution = (await RolloutLedger.tools(selected, rootID)).find(
        (tool) => tool.messageID === message.info.id && tool.toolCallID === part.callID,
      )
      const process = execution
        ? (await RolloutLedger.processes(selected, rootID)).find((process) => process.toolExecutionID === execution.id)
        : undefined
      if (process) {
        const active = ProcessRegistry.get(process.id) ?? ProcessRegistry.getFinished(process.id)
        const captured = active
          ? { text: active.output, truncated: active.truncated }
          : await processText(selected, process.stream)
        const masked = await SecretMask.transformResult({ output: captured.text }, new AbortController().signal)
        return {
          part,
          text: String(masked.output),
          evidenceMissing: false,
          truncated: captured.truncated,
          process: {
            status: process.status,
            exitCode: process.exitCode,
            signal: process.signal,
            endedAt: process.ended,
          },
        }
      }
    }
    if (!part.activityEvidence?.content) return { part, evidenceMissing: true }
    const reference = part.activityEvidence.content
    const bytes = await readPrefix(selected, reference)
    return {
      part,
      text: new TextDecoder().decode(bytes),
      evidenceMissing: false,
      truncated: reference.bytes > bytes.byteLength || part.activityEvidence?.truncated,
    }
  }

  async function readPrefix(owner: RolloutArtifact.Owner, reference: RolloutArtifact.Ref) {
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of RolloutArtifact.read(owner, reference)) {
      const bounded = chunk.subarray(0, Math.max(0, 512 * 1024 - length))
      chunks.push(bounded)
      length += bounded.byteLength
      if (length === 512 * 1024) break
    }
    return Buffer.concat(chunks)
  }

  async function processText(owner: RolloutArtifact.Owner, reference: RolloutArtifact.Ref) {
    const bytes = await readPrefix(owner, reference)
    const chunks: Uint8Array[] = []
    let offset = 0
    while (offset + 5 <= bytes.length) {
      const length = bytes.readUInt32BE(offset + 1)
      if (offset + 5 + length > bytes.length) break
      chunks.push(bytes.subarray(offset + 5, offset + 5 + length))
      offset += 5 + length
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated: reference.bytes > offset }
  }
}
