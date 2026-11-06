import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { acceptanceRuntime, until } from "./runtime"
import type { Settings } from "./settings"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import type { Driver } from "./runner"

export function attachments(settings: Settings): Driver {
  return async (context) => {
    await using host = await acceptanceRuntime(context.directory, settings)
    const { runtime, model } = host
    const kind = context.scenario.id.replace("attachments-", "")
    const workspace = path.join(context.directory, "project")
    await fs.mkdir(workspace)
    const barriers: string[] = []
    return await runtime.run(async () => {
      const scope = kind === "home" ? Scope.home() : (await Scope.fromDirectory(workspace)).scope
      return ScopeContext.provide({
        scope,
        ...(kind !== "workspace" ? { workspace: null } : {}),
        fn: async () => {
          const session = await Session.create({
            title: "Attachment acceptance",
            ...(kind !== "workspace" ? { workspace: null } : {}),
            controlProfile: "full_access",
          })
          const markers = [crypto.randomUUID().replaceAll("-", ""), crypto.randomUUID().replaceAll("-", "")]
          const managed = Buffer.from(`Primary record: ${markers[0]}\n`)
          const inline = Buffer.from(`Supplementary record: ${markers[1]}\n`)
          const asset = await Asset.write(managed, "text/plain", "records.txt")
          const sentinel = `DO_NOT_SEND_${crypto.randomUUID()}`
          const bad = await SessionInbox.enqueueUser({
            sessionID: session.id,
            model,
            agent: context.scenario.agent,
            parts: [
              { type: "text", text: sentinel },
              { type: "attachment", filename: "missing.txt", mime: "text/plain", url: "asset://0000000000000000.txt" },
            ],
          })
          const good = await SessionInbox.enqueueUser({
            sessionID: session.id,
            model,
            agent: context.scenario.agent,
            parts: [
              {
                type: "text",
                text: "Read both attached records. Return their two complete record identifiers exactly. No tools are needed.",
              },
              { type: "attachment", filename: "records.txt", mime: "text/plain", url: `asset://${asset}` },
              {
                type: "attachment",
                filename: "supplement.txt",
                mime: "text/plain",
                url: `data:text/plain;base64,${inline.toString("base64")}`,
              },
            ],
          })
          try {
            await SessionManager.wake(session.id)
            const goodStatus = await until(
              () => SessionInputStatus.get({ sessionID: session.id, messageID: good.messageID }),
              (status) => ["completed", "failed"].includes(status.state),
              settings.deadlineMs,
            )
            const badStatus = await SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID })
            if (badStatus.state === "failed") barriers.push("failed-input-parked")
            if (goodStatus.state === "completed") barriers.push("successor-completed")
            const root = await createUserMessage({
              sessionID: session.id,
              model,
              agent: context.scenario.agent,
              parts: [
                {
                  type: "text",
                  text: "Confirm the same two record identifiers from the previous attachments, exactly.",
                },
              ],
            })
            const injected = []
            for (const mode of ["steer", "context"] as const) {
              const item = await SessionInbox.deliver({
                sessionID: session.id,
                mode,
                message: {
                  role: "user",
                  model,
                  parts: [
                    { type: "text", text: sentinel },
                    {
                      type: "attachment",
                      filename: `${mode}.txt`,
                      mime: "text/plain",
                      url: "data:text/plain;base64,!!!",
                    },
                  ],
                },
              })
              injected.push({ mode, item })
            }
            await SessionInvoke.loop.force(session.id)
            const inbox = await SessionInbox.list(session.id)
            for (const { mode, item } of injected)
              if (inbox.some((entry) => entry.id === item.itemID && entry.status === "failed"))
                barriers.push(`${mode}-checked`)
            const native = path.join(workspace, "native.txt")
            await Bun.write(native, "Native file requires a Workspace")
            let nativeAccepted = false
            try {
              await createUserMessage({
                sessionID: session.id,
                model,
                noReply: true,
                parts: [
                  { type: "attachment", filename: "native.txt", mime: "text/plain", url: pathToFileURL(native).href },
                ],
              })
              nativeAccepted = true
            } catch {
              nativeAccepted = false
            }
            const localReferencePolicy = nativeAccepted === (kind === "workspace")
            if (localReferencePolicy) barriers.push("local-reference-checked")
            const messages = await Session.messages({ sessionID: session.id })
            const answer = messages
              .filter((entry) => entry.info.role === "assistant")
              .flatMap((entry) => entry.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            const requests = await readRequests(context.directory)
            const transmitted = (
              await Promise.all(
                requests.map((entry) =>
                  Bun.file(path.join(context.directory, "requests", entry.id, "request.bin")).text(),
                ),
              )
            ).join("\n")
            const environments = await Environment.list(scope.id)
            const actual = await Asset.read(asset)
            const retained = await SessionInbox.get(session.id, bad.id)
            const observations = {
              markerRecovered: markers.every((marker) => answer.includes(marker) && transmitted.includes(marker)),
              partialInputSent: transmitted.includes(sentinel),
              failedInputRetained:
                retained.message !== undefined &&
                bad.message !== undefined &&
                JSON.stringify(retained.message.parts) === JSON.stringify(bad.message.parts),
              queueProgressed: goodStatus.state === "completed",
              localReferencePolicy,
              allocatedCompute: environments.filter((entry) => entry.allocation !== undefined).length,
              managedBytesPreserved:
                actual !== undefined && digest(new Uint8Array(await actual.arrayBuffer())) === digest(managed),
            }
            await atomicJSON(path.join(context.directory, "observations.json"), observations)
            await atomicJSON(path.join(context.directory, "product.json"), {
              session: await Session.get(session.id),
              messages,
              inbox,
              environments,
              goodStatus,
              badStatus,
              continuationRoot: root.info.id,
            })
            await atomicJSON(path.join(context.directory, "physical.json"), {
              originalHash: digest(managed),
              storedHash: actual ? digest(new Uint8Array(await actual.arrayBuffer())) : null,
              nativeHash: digest(new Uint8Array(await Bun.file(native).arrayBuffer())),
            })
            await atomicJSON(path.join(context.directory, "transport.json"), {
              requests,
              sentinelSent: observations.partialInputSent,
            })
            return {
              status: "passed",
              model: observations.markerRecovered ? "passed" : "failed",
              barriers,
              requests,
              evidence: await Promise.all([
                sealEvidence(context.directory, "observations.json", "product"),
                sealEvidence(context.directory, "product.json", "product"),
                sealEvidence(context.directory, "physical.json", "external"),
                sealEvidence(context.directory, "transport.json", "transport"),
              ]),
            }
          } finally {
            await SessionInvoke.cancel(session.id)
          }
        },
      })
    })
  }
}
