import path from "node:path"
import { z } from "zod"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { acceptanceRuntime, type Settings } from "./runtime"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import { mediaFixtures } from "./media-fixtures"
import type { Driver } from "./runner"

export function media(settings: Settings): Driver {
  return async (context) => {
    if (!settings.chromium) throw new Error("Freeze a Chromium executable before creating media fixtures")
    const visualChild = context.scenario.id === "vision-child"
    const fixtures = await mediaFixtures(settings.chromium)
    const selected = visualChild ? fixtures.slice(0, 1) : fixtures
    for (const file of selected) await Bun.write(path.join(context.directory, file.filename), file.bytes)
    await atomicJSON(
      path.join(context.directory, "fixtures.json"),
      selected.map(({ bytes, ...file }) => ({ ...file, sha256: digest(bytes) })),
    )
    const provider = z.record(z.string(), z.record(z.string(), z.json())).parse(settings.config.provider ?? {})
    const current = provider[settings.providerID] ?? {}
    const models = z.record(z.string(), z.record(z.string(), z.json())).parse(current.models ?? {})
    const parentID = visualChild ? "acceptance-text-parent" : settings.modelID
    const effective = visualChild
      ? {
          ...settings,
          config: {
            ...settings.config,
            provider: {
              ...provider,
              [settings.providerID]: {
                ...current,
                models: {
                  ...models,
                  [parentID]: {
                    ...models[settings.modelID],
                    id: settings.modelID,
                    name: "Acceptance text parent",
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
              },
            },
          },
        }
      : settings
    await using host = await acceptanceRuntime(context.directory, effective)
    return await host.runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({
            title: "Mixed media acceptance",
            workspace: null,
            controlProfile: "full_access",
          })
          const files = await Promise.all(
            selected.map(async (file) => ({ ...file, asset: await Asset.write(file.bytes, file.mime, file.filename) })),
          )
          const excluded = `EXCLUDED_${crypto.randomUUID()}`
          const request = await createUserMessage({
            sessionID: session.id,
            model: { providerID: settings.providerID, modelID: parentID },
            agent: context.scenario.agent,
            parts: [
              {
                type: "text",
                text: visualChild
                  ? "Use look_at to ask the vision agent to read the record identifier in the attached image. Wait for its result and return the exact identifier. It is only present in the image."
                  : "Read every attached image and document. Return each filename and the exact record identifier from its content. Do not infer identifiers from filenames. Ignore explicitly excluded attachments.",
              },
              ...files.map((file) => ({
                type: "attachment" as const,
                filename: file.filename,
                mime: file.mime,
                url: `asset://${file.asset}`,
              })),
              {
                type: "attachment",
                filename: "excluded.txt",
                mime: "text/plain",
                model: { mode: "none" },
                url: `data:text/plain;base64,${Buffer.from(excluded).toString("base64")}`,
              },
            ],
          })
          const projected = JSON.stringify(MessageV2.toModelMessage([request]))
          const policy: Array<{ filename: string; original: string; stored: string; retainedBinary: boolean }> = []
          const binarySession = await Session.create({ workspace: null, title: "Binary transport policy" })
          for (const [filename, mime, prefix] of [
            ["record.wav", "audio/wav", "RIFF"],
            ["record.mp4", "video/mp4", "ftyp"],
          ] as const) {
            const bytes = Buffer.concat([Buffer.from(prefix!), crypto.getRandomValues(new Uint8Array(64))])
            const binary = await createUserMessage({
              sessionID: binarySession.id,
              model: host.model,
              noReply: true,
              parts: [
                {
                  type: "attachment",
                  filename,
                  mime: mime!,
                  url: `data:${mime};base64,${bytes.toString("base64")}`,
                  model: { mode: "none" },
                },
              ],
            })
            const attachment = binary.parts.find((part) => part.type === "attachment")
            const stored = attachment?.localPath ? await Bun.file(attachment.localPath).bytes() : new Uint8Array()
            const disposition = Attachment.policy({ filename, mime })
            policy.push({
              filename: filename!,
              original: digest(bytes),
              stored: digest(stored),
              retainedBinary: disposition.keepBinary && !disposition.extractText,
            })
          }
          await SessionInvoke.loop.force(session.id)
          const messages = await Session.messages({ sessionID: session.id })
          const answer = messages
            .filter((entry) => entry.info.role === "assistant" && entry.info.parentID === request.info.id)
            .flatMap((entry) => entry.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          const children = await Session.children(session.id)
          const childMessages = await Promise.all(children.map((child) => Session.messages({ sessionID: child.id })))
          const childParts = childMessages.flat().flatMap((message) => message.parts)
          const parentTools = messages
            .flatMap((entry) => entry.parts)
            .filter((part) => part.type === "tool")
            .filter((part) => part.tool === "look_at")
          const completedTools = parentTools.filter((part) => part.state.status === "completed")
          const childRecorded = childMessages.some((history) =>
            history.some((message) => message.info.role === "assistant" && message.info.time.completed !== undefined),
          )
          const parentWaited =
            completedTools.length > 0 &&
            completedTools.every((part) => {
              if (part.state.status !== "completed") return false
              const finished = part.state.time.end
              return childMessages.some((history) =>
                history.some(
                  (message) =>
                    message.info.role === "assistant" &&
                    message.info.time.completed !== undefined &&
                    message.info.time.completed <= finished,
                ),
              )
            })
          const requests = await readRequests(context.directory)
          const wire = (
            await Promise.all(
              requests.map((entry) =>
                Bun.file(path.join(context.directory, "requests", entry.id, "request.bin")).text(),
              ),
            )
          ).join("\n")
          const originals = await Promise.all(
            files.map(async (file) => ({
              filename: file.filename,
              original: digest(file.bytes),
              stored: digest(await Bun.file(Asset.resolvePath(file.asset)!).bytes()),
            })),
          )
          const markersRecovered = selected.every((file) => answer.includes(file.marker))
          const observations = {
            markersRecovered,
            imageMarkerRecovered: markersRecovered,
            excludedLeaked: wire.includes(excluded),
            namesPreserved: selected.every((file) => projected.includes(file.filename)),
            binaryPreserved:
              policy.every((entry) => entry.retainedBinary && entry.original === entry.stored) &&
              originals.every((entry) => entry.original === entry.stored),
            childRecorded,
            parentWaited,
          }
          const barriers: string[] = []
          if (visualChild) {
            if (parentTools.length) barriers.push("child-invoked")
            if (childRecorded && childParts.some((part) => part.type === "attachment" && part.mime === "image/png"))
              barriers.push("child-completed")
            if (parentWaited && markersRecovered) barriers.push("parent-completed")
          } else {
            if (
              selected
                .filter((file) => !file.mime.startsWith("image/"))
                .every((file) => projected.includes(file.marker))
            )
              barriers.push("documents-extracted")
            if (selected.filter((file) => file.mime.startsWith("image/")).every((file) => answer.includes(file.marker)))
              barriers.push("images-read")
            if (!observations.excludedLeaked) barriers.push("excluded-checked")
            if (observations.binaryPreserved) barriers.push("binary-checked")
          }
          await atomicJSON(path.join(context.directory, "observations.json"), observations)
          await atomicJSON(path.join(context.directory, "product.json"), {
            messages,
            children,
            childMessages,
            projected,
          })
          await atomicJSON(path.join(context.directory, "physical.json"), { originals, policy })
          await atomicJSON(path.join(context.directory, "transport.json"), {
            requests,
            excludedLeaked: observations.excludedLeaked,
          })
          return {
            status: "passed",
            model: markersRecovered ? "passed" : "failed",
            barriers,
            requests,
            evidence: await Promise.all([
              sealEvidence(context.directory, "observations.json", "product"),
              sealEvidence(context.directory, "product.json", "product"),
              sealEvidence(context.directory, "physical.json", "external"),
              sealEvidence(context.directory, "transport.json", "transport"),
              ...selected.map((file) => sealEvidence(context.directory, file.filename, "external")),
            ]),
          }
        },
      }),
    )
  }
}
