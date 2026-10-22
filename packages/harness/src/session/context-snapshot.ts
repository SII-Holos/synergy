import { z } from "zod"
import { createHash } from "node:crypto"
import { Identifier } from "../id/id"
import { prepareSessionMigrations } from "../migration"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { SessionHistory } from "./history"
import { SessionManager } from "./manager"
import { MessageV2 } from "./message-v2"
import { ModelSelection } from "./model-selection-schema"
import { SessionProgress } from "./progress"
import { RolloutArtifact } from "./rollout/artifact"
import { RolloutLedger } from "./rollout/ledger"

export namespace SessionContextSnapshot {
  export const Anchor = z
    .object({ rootID: z.string(), assistantID: z.string() })
    .meta({ ref: "SessionCompletionAnchor" })
  export type Anchor = z.infer<typeof Anchor>
  export const Stamp = Anchor.extend({
    scopeID: z.string(),
    sessionID: z.string(),
    model: ModelSelection.Model,
    revision: z.string(),
    sources: z.array(z.object({ key: z.array(z.string()), revision: z.string().nullable() })),
  }).meta({ ref: "SessionContextStamp" })
  export type Stamp = z.infer<typeof Stamp>

  export class UnavailableError extends Error {
    constructor() {
      super("A successfully completed root is required")
      this.name = "SessionContextUnavailableError"
    }
  }

  function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }

  export async function capture(input: { sessionID: string; expected?: Anchor; signal?: AbortSignal }) {
    const initial = await SessionManager.requireSession(input.sessionID)
    await prepareSessionMigrations({ scopeID: initial.scope.id, sessionID: initial.id })
    input.signal?.throwIfAborted()
    return Storage.snapshot(async (tx) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const messages = await SessionHistory.detachedModelMessages(input)
      const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)?.info
      const terminal = messages.findLast((message) => message.info.rootID === root?.id)?.info
      if (
        !root ||
        root.role !== "user" ||
        !MessageV2.isHumanInput(root) ||
        session.parentID ||
        !terminal ||
        terminal.role !== "assistant" ||
        terminal.summary ||
        terminal.error ||
        !SessionProgress.isTerminalAssistant(terminal) ||
        terminal.time.completed === undefined ||
        (input.expected && (input.expected.rootID !== root.id || input.expected.assistantID !== terminal.id))
      )
        throw new UnavailableError()
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
      const run = await RolloutLedger.getRun(owner, root.id).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!run || run.status !== "completed" || run.recording === "failed" || run.cancelRequestedAt)
        throw new UnavailableError()
      const scopeID = Identifier.asScopeID(session.scope.id)
      const sessionID = Identifier.asSessionID(session.id)
      const keys = [
        StoragePath.sessionInfo(scopeID, sessionID),
        StoragePath.sessionMessageOrderState(scopeID, sessionID),
        [...RolloutArtifact.root(owner), "runs", root.id, "info"],
        ...messages.flatMap(({ info, parts }) => [
          StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(info.id)),
          StoragePath.sessionDisplayPartsState(scopeID, sessionID, info.id),
          ...parts.map((part) =>
            StoragePath.messagePart(scopeID, sessionID, Identifier.asMessageID(info.id), Identifier.asPartID(part.id)),
          ),
        ]),
      ]
      const revisions = await tx.revisions(keys)
      const sources = keys.map((key, index) => ({ key, revision: revisions[index]?.toString() ?? null }))
      const model = session.modelSelection?.selected.model ?? session.modelOverride ?? root.model
      const stamp: Stamp = {
        scopeID,
        sessionID,
        rootID: root.id,
        assistantID: terminal.id,
        model,
        sources,
        revision: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
      }
      input.signal?.throwIfAborted()
      return freeze({ messages, model, stamp })
    })
  }

  export async function isCurrent(stamp: Stamp) {
    const revisions = await Storage.revisions(stamp.sources.map((source) => source.key))
    return stamp.sources.every((source, index) => source.revision === (revisions[index]?.toString() ?? null))
  }
}
