import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import {
  SessionTransferOwners as Owners,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkflowInfo } from "./session-schema"
import { LightLoopTerminalRecord } from "./light-loop/terminal-hook"
import { LightLoopRuntime } from "./light-loop/runtime"

const Proof = z.strictObject({
  version: z.literal(1),
  workflow: WorkflowInfo.passthrough().optional(),
  terminal: z.boolean(),
})
const terminalKey = (session: Readonly<Session.Info>) =>
  StoragePath.sessionLightLoopTerminal(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
async function terminal(session: Readonly<Session.Info>) {
  const [record] = await Storage.readMany([terminalKey(session)])
  return record === undefined ? undefined : LightLoopTerminalRecord.passthrough().parse(record)
}
const key = (session: Readonly<Session.Info>) => ["light-loop-transfer", session.id]
async function* record(path: string[], value: unknown) {
  yield {
    id: JSON.stringify(path),
    kind: "record" as const,
    metadata: { key: path },
    content: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(value))
    })(),
  }
}

async function* subtree(session: Readonly<Session.Info>, ancestors = new Set<string>()): AsyncGenerator<Session.Info> {
  if (ancestors.has(session.id))
    throw new Owners.Rejected({ message: "Workflow portability found cyclic Session ancestry" })
  const lineage = new Set([...ancestors, session.id])
  yield session
  let cursor: Parameters<typeof Session.childPage>[0]["cursor"]
  for (;;) {
    const page = await ScopeContext.provide({
      scope: session.scope,
      fn: () => Session.childPage({ parentID: session.id, cursor, limit: 50, includeArchived: true }),
    })
    for (const child of page.items) yield* subtree(child, lineage)
    if (!page.nextCursor) return
    cursor = page.nextCursor
  }
}

async function validated(context: Owners.TargetContext) {
  let proof: z.infer<typeof Proof> | undefined
  let retained: z.infer<typeof LightLoopTerminalRecord> | undefined
  for await (const entry of context.staged.records()) {
    context.signal.throwIfAborted()
    if (isDeepStrictEqual(entry.key, key(context.session))) {
      if (proof) throw new Owners.Rejected({ message: "Duplicated Light Loop transfer proof" })
      proof = Proof.parse(entry.value)
    } else if (isDeepStrictEqual(entry.key, terminalKey(context.session))) {
      if (retained) throw new Owners.Rejected({ message: "Duplicated Light Loop terminal record" })
      retained = LightLoopTerminalRecord.passthrough().parse(entry.value)
      if (retained.sessionID !== context.session.id)
        throw new Owners.Rejected({ message: "Foreign Light Loop terminal identity" })
    } else throw new Owners.Rejected({ message: "Foreign Light Loop portability record" })
  }
  if (
    !proof ||
    proof.terminal !== !!retained ||
    !isDeepStrictEqual(
      proof.workflow,
      context.session.workflow?.kind === "lightloop" ? context.session.workflow : undefined,
    )
  )
    throw new Owners.Rejected({ message: "Incomplete or changed Light Loop workflow evidence" })
  if (proof.workflow?.pluginOwner || retained?.pluginOwner)
    throw new Owners.Rejected({ message: "Light Loop requires the exact plugin generation portability owner" })
  for await (const _ of context.staged.artifacts())
    throw new Owners.Rejected({ message: "Unexpected Light Loop binary content" })
  return retained
}

export function registerLightLoopTransferOwner() {
  Owners.register("light-loop", {
    version: 1,
    reads: [1],
    applies: async (session) => session.workflow?.kind === "lightloop" || !!(await terminal(session)),
    async inspect(context) {
      const workflow = context.session.workflow
      const retained = await terminal(context.session)
      return {
        requirements:
          (workflow?.kind === "lightloop" && workflow.pluginOwner) || retained?.pluginOwner
            ? [
                {
                  code: "light_loop_plugin_generation",
                  owner: "plugin-light-loop",
                  label: "Install and authorize the exact Light Loop plugin generation",
                  recoverable: true,
                },
              ]
            : [],
        children: (async function* () {})(),
      }
    },
    async freeze(context) {
      await LightLoopRuntime.suspendForTransfer(context.session.id)
    },
    async *export(context) {
      const session = await Session.get(context.session.id)
      const retained = await terminal(session)
      yield* record(
        key(session),
        Proof.parse({
          version: 1,
          workflow: session.workflow?.kind === "lightloop" ? session.workflow : undefined,
          terminal: !!retained,
        }),
      )
      if (retained) yield* record(terminalKey(session), retained)
    },
    async validate(context) {
      await validated(context)
    },
    async publish(context) {
      const retained = await validated(context)
      if (!retained) return
      const [existing] = await Storage.readMany([terminalKey(context.session)])
      if (existing !== undefined && !isDeepStrictEqual(existing, retained))
        throw new Owners.Rejected({ message: "Destination Light Loop terminal record conflicts" })
      await Storage.write(terminalKey(context.session), retained)
    },
    async resume(context) {
      for await (const session of subtree(context.session)) {
        context.signal.throwIfAborted()
        if (session.workflow?.kind !== "lightloop") continue
        const binding = await Epochs.ownerResumeBinding({ sessionID: session.id, rootSessionID: context.rootSessionID })
        if (!binding) continue
        if (session.workflow.pluginOwner)
          throw new Owners.Rejected({ message: "Light Loop plugin generation is unavailable for continuation" })
        if (session.workflow.deadlineAt) LightLoopRuntime.scheduleDeadline(session.id, session.workflow.deadlineAt)
      }
    },
  })
}
