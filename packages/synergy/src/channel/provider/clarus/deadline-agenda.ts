import { Agenda, AgendaStore } from "@/agenda"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { Lock } from "@/util/lock"
import { ClarusDeadline } from "./assignment-prompt"

function identityHash(accountId: string, projectID: string, taskID: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of [accountId, projectID, taskID]) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

export namespace ClarusDeadlineAgenda {
  export function itemID(input: { accountId: string; projectID: string; taskID: string }): string {
    return `agd_${identityHash(input.accountId, input.projectID, input.taskID).slice(0, 26)}`
  }

  export async function sync(input: {
    accountId: string
    projectID: string
    taskID: string
    sessionID: string
    deadlineAt: string | null | undefined
    active: boolean
  }): Promise<void> {
    const hash = identityHash(input.accountId, input.projectID, input.taskID)
    const id = `agd_${hash.slice(0, 26)}`
    using _ = await Lock.write(`channel:clarus:deadline:${hash}`)
    const session = await Session.get(input.sessionID)
    const scope = session.scope as Scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const existing = await AgendaStore.get(scope.id, id).catch(() => undefined)
        if (!input.active || !input.deadlineAt) {
          if (existing && existing.status !== "cancelled" && existing.status !== "done") {
            await Agenda.update(id, { status: "cancelled" }, scope.id)
          }
          return
        }

        const deadlineAt = Date.parse(input.deadlineAt)
        if (!Number.isFinite(deadlineAt)) {
          throw new Error(`Invalid Clarus task deadline: ${input.deadlineAt}`)
        }

        const title = `Clarus deadline: ${input.taskID}`
        const prompt = ClarusDeadline.guidance()
        const triggers = [{ type: "at" as const, at: ClarusDeadline.triggerAt(deadlineAt) }]

        if (existing) {
          await Agenda.update(
            id,
            {
              title,
              status: "active",
              tags: ["clarus", "deadline"],
              triggers,
              prompt,
            },
            scope.id,
          )
          return
        }

        await Agenda.create(
          {
            title,
            prompt,
            triggers,
            tags: ["clarus", "deadline"],
            createdBy: "agent",
            sessionID: input.sessionID,
            deliveryMode: "session_guidance",
          },
          id,
        )
      },
    })
  }

  export async function cancel(input: { accountId: string; projectID: string; taskID: string }): Promise<void> {
    const id = itemID(input)
    const found = await AgendaStore.find(id).catch(() => undefined)
    if (!found || found.item.status === "cancelled" || found.item.status === "done") return
    const scope = await Scope.fromID(found.scopeID)
    if (!scope) return
    await ScopeContext.provide({
      scope,
      fn: () => Agenda.update(id, { status: "cancelled" }, found.scopeID),
    })
  }
}
