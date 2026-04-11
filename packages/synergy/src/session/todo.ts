import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "../id/id"
import { SessionManager } from "./manager"
import { Scope } from "@/scope"

export namespace Todo {
  const { asSessionID } = Identifier
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
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    await Storage.write(StoragePath.sessionTodo(scopeID, asSessionID(input.sessionID)), input.todos)
    Bus.publish(Event.Updated, input)
  }

  export async function get(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    return Storage.read<Info[]>(StoragePath.sessionTodo(scopeID, asSessionID(sessionID)))
      .then((x) => x || [])
      .catch(() => [])
  }
}
