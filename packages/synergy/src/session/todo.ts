import { emptyOnNotFound } from "./storage-read"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "../id/id"
import type { Scope } from "@/scope"

export namespace Todo {
  const { asSessionID } = Identifier

  async function resolveScopeID(sessionID: string) {
    const { SessionManager } = await import("./manager")
    const session = await SessionManager.requireSession(sessionID)
    return Identifier.asScopeID((session.scope as Scope).id)
  }
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
      id: z.string().describe("Unique identifier for the todo item"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    const scopeID = await resolveScopeID(input.sessionID)
    await Storage.write(StoragePath.sessionTodo(scopeID, asSessionID(input.sessionID)), input.todos)
    Bus.publish(Event.Updated, input)
  }

  export async function get(sessionID: string) {
    const scopeID = await resolveScopeID(sessionID)
    return Storage.read<Info[]>(StoragePath.sessionTodo(scopeID, asSessionID(sessionID)))
      .then((x) => x || [])
      .catch(emptyOnNotFound<Info>)
  }
}
