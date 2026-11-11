import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionTransferOwners as Owners } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkflowInfo } from "./session-schema"

const Proof = z.strictObject({ version: z.literal(1), workflow: WorkflowInfo.passthrough() })
const key = (id: string) => ["boss-transfer", id]
async function validate(context: Owners.TargetContext) {
  let found = false
  for await (const entry of context.staged.records()) {
    if (
      found ||
      !isDeepStrictEqual(entry.key, key(context.session.id)) ||
      !isDeepStrictEqual(Proof.parse(entry.value).workflow, context.session.workflow)
    )
      throw new Owners.Rejected({ message: "Boss portability contains changed or foreign workflow evidence" })
    found = true
  }
  if (!found) throw new Owners.Rejected({ message: "Boss portability evidence is missing" })
  for await (const _ of context.staged.artifacts())
    throw new Owners.Rejected({ message: "Boss has no separate binary task authority" })
}

export function registerBossTransferOwner() {
  Owners.register("boss", {
    version: 1,
    reads: [1],
    applies: (session) => session.workflow?.kind === "boss",
    async inspect(context) {
      return {
        requirements: [],
        children: (async function* () {
          let cursor: Parameters<typeof Session.childPage>[0]["cursor"]
          for (;;) {
            const page = await ScopeContext.provide({
              scope: context.session.scope,
              fn: () => Session.childPage({ parentID: context.session.id, cursor, limit: 50, includeArchived: true }),
            })
            for (const child of page.items) yield child.id
            if (!page.nextCursor) return
            cursor = page.nextCursor
          }
        })(),
      }
    },
    async freeze() {},
    async *export(context) {
      const path = key(context.session.id)
      const session = await Session.get(context.session.id)
      yield {
        id: JSON.stringify(path),
        kind: "record",
        metadata: { key: path },
        content: (async function* () {
          yield new TextEncoder().encode(JSON.stringify(Proof.parse({ version: 1, workflow: session.workflow })))
        })(),
      }
    },
    validate,
    async publish(context) {
      await validate(context)
    },
  })
}
