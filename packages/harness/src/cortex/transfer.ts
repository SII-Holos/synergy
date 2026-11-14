import { z } from "zod"
import { createHash } from "node:crypto"
import { Session } from "../session"
import { ScopeContext } from "../scope/context"
import { SessionTransferOwners as Owners } from "../session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../session/transfer-epochs"
import { CortexTransferHolds } from "./transfer-holds"
import { Cortex } from "./manager"

const Proof = z.strictObject({
  version: z.literal(1),
  sessionID: z.string(),
  taskID: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})
const digest = (session: Readonly<Session.Info>) =>
  createHash("sha256")
    .update(
      JSON.stringify(session.cortex, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest("hex")
const terminal = (status: string) => !["queued", "running"].includes(status)

async function* children(session: Readonly<Session.Info>) {
  let cursor: Parameters<typeof Session.childPage>[0]["cursor"]
  for (;;) {
    const page = await ScopeContext.provide({
      scope: session.scope,
      fn: () => Session.childPage({ parentID: session.id, cursor, limit: 50, includeArchived: true }),
    })
    for (const child of page.items) yield child.id
    if (!page.nextCursor) return
    cursor = page.nextCursor
  }
}

async function validate(context: Owners.TargetContext) {
  const cortex = context.session.cortex
  if (!cortex) throw new Owners.Rejected({ message: "Cortex portability has no canonical delegation" })
  if (
    !terminal(cortex.status) &&
    (!cortex.transfer ||
      cortex.transfer.handoffID !== context.handoffID ||
      cortex.transfer.rootSessionID !== context.rootSessionID)
  )
    throw new Owners.Rejected({ message: "Cortex portability requires its exact drained continuation" })
  let count = 0
  for await (const record of context.staged.records()) {
    context.signal.throwIfAborted()
    if (record.key.length !== 2 || record.key[0] !== "cortex-transfer" || record.key[1] !== context.session.id)
      throw new Owners.Rejected({ message: "Cortex portability contains foreign owner data" })
    const proof = Proof.parse(record.value)
    if (
      proof.sessionID !== context.session.id ||
      proof.taskID !== cortex.taskID ||
      proof.digest !== digest(context.session)
    )
      throw new Owners.Rejected({ message: "Cortex canonical delegation changed in transit" })
    count++
  }
  if (count !== 1) throw new Owners.Rejected({ message: "Cortex portability evidence is incomplete or duplicated" })
  for await (const _ of context.staged.artifacts())
    throw new Owners.Rejected({ message: "Cortex portability has unexpected binary data" })
}

export function registerCortexTransferOwner() {
  Owners.register("cortex", {
    version: 1,
    reads: [1],
    applies: (session) => !!session.cortex,
    async inspect(context) {
      const cortex = context.session.cortex!
      const live = Cortex.get(cortex.taskID)
      const requirements: Owners.Requirement[] = []
      if (
        !terminal(cortex.status) &&
        live?.sessionID !== context.session.id &&
        !(cortex.transfer?.handoffID === context.handoffID && (await Epochs.isFrozen(context.session.id)))
      )
        requirements.push({
          code: "cortex_cold_active",
          owner: "cortex",
          label: "Reconcile the interrupted Cortex owner before transfer",
          recoverable: true,
        })
      if (cortex.owner)
        requirements.push({
          code: "cortex_plugin_generation",
          owner: "plugin",
          label: "Install and authorize the exact task plugin generation on the destination",
          recoverable: true,
        })
      return { requirements, children: children(context.session) }
    },
    async freeze(context) {
      await Cortex.suspendForTransfer(context.session.cortex!.taskID, {
        sessionID: context.session.id,
        rootSessionID: context.rootSessionID,
        handoffID: context.handoffID,
        signal: context.signal,
      })
    },
    async *export(context) {
      const session = await Session.get(context.session.id)
      const key = ["cortex-transfer", session.id]
      yield {
        id: JSON.stringify(key),
        kind: "record",
        metadata: { key },
        content: (async function* () {
          yield new TextEncoder().encode(
            JSON.stringify(
              Proof.parse({
                version: 1,
                sessionID: session.id,
                taskID: session.cortex!.taskID,
                digest: digest(session),
              }),
            ),
          )
        })(),
      }
    },
    validate,
    async publish(context) {
      await validate(context)
      await CortexTransferHolds.index(context.session)
    },
    async resume(context) {
      for await (const hold of CortexTransferHolds.list(context.session.scope.id, context.rootSessionID)) {
        context.signal.throwIfAborted()
        const session = await Session.get(hold.sessionID)
        if (
          session.cortex?.taskID !== hold.taskID ||
          session.cortex.transfer?.rootSessionID !== context.rootSessionID ||
          session.cortex.transfer.handoffID !== hold.handoffID
        )
          throw new Owners.Rejected({ message: "Cortex transfer hold index disagrees with its canonical task" })
        await Cortex.resumeTransferred(session.id, context.intentID)
      }
    },
  })
}
