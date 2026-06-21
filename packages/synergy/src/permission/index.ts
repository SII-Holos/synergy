import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { Plugin } from "../plugin"
import { Instance } from "../scope/instance"
import { TimeoutConfig } from "@/util/timeout-config"

export namespace Permission {
  const log = Log.create({ service: "permission" })

  export const Info = z
    .object({
      id: z.string(),
      type: z.string(),
      pattern: z.union([z.string(), z.array(z.string())]).optional(),
      sessionID: z.string(),
      messageID: z.string(),
      callID: z.string().optional(),
      message: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        created: z.number(),
      }),
    })
    .meta({
      ref: "Permission",
    })
  export type Info = z.infer<typeof Info>

  export const Response = z.enum(["once", "session", "reject"])
  export type Response = z.infer<typeof Response>

  export const Event = {
    Updated: BusEvent.define("permission.updated", Info),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        permissionID: z.string(),
        response: Response,
      }),
    ),
  }

  const state = Instance.state(
    () => {
      const pending: {
        [sessionID: string]: {
          [permissionID: string]: {
            info: Info
            resolve: () => void
            reject: (e: any) => void
          }
        }
      } = {}

      const sessionMemory: {
        [sessionID: string]: Set<string>
      } = {}

      return {
        pending,
        sessionMemory,
      }
    },
    async (state) => {
      for (const pending of Object.values(state.pending)) {
        for (const item of Object.values(pending)) {
          item.reject(new RejectedError(item.info.sessionID, item.info.id, item.info.callID, item.info.metadata))
        }
      }
    },
  )

  function memoryKey(toolName: string, metadata: Record<string, any>): string {
    const capability = metadata?.capability ?? metadata?.type ?? "default"
    return `${toolName}:${capability}`
  }

  export function pending() {
    return state().pending
  }

  export function list() {
    const { pending } = state()
    const result: Info[] = []
    for (const items of Object.values(pending)) {
      for (const item of Object.values(items)) {
        result.push(item.info)
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function ask(input: {
    type: Info["type"]
    message: Info["message"]
    pattern?: Info["pattern"]
    callID?: Info["callID"]
    sessionID: Info["sessionID"]
    messageID: Info["messageID"]
    metadata: Info["metadata"]
  }) {
    const { pending } = state()
    log.info("asking", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      toolCallID: input.callID,
      pattern: input.pattern,
    })
    const info: Info = {
      id: Identifier.ascending("permission"),
      type: input.type,
      pattern: input.pattern,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      message: input.message,
      metadata: input.metadata,
      time: {
        created: Date.now(),
      },
    }

    switch (
      await Plugin.trigger("permission.ask", info, {
        status: "ask",
      }).then((x) => x.status)
    ) {
      case "deny":
        throw new RejectedError(info.sessionID, info.id, info.callID, info.metadata)
      case "allow":
        return
    }

    const memKey = memoryKey(input.type, input.metadata)
    const memory = state().sessionMemory[input.sessionID]
    if (memory?.has(memKey)) {
      log.info("auto-allowed by session memory", {
        sessionID: input.sessionID,
        key: memKey,
      })
      return
    }

    const timeoutCfg = await TimeoutConfig.resolve()
    const ms = timeoutCfg.permissionAskMs
    pending[input.sessionID] = pending[input.sessionID] || {}
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(async () => {
        const match = pending[input.sessionID]?.[info.id]
        if (!match) return
        delete pending[input.sessionID][info.id]
        log.warn("permission ask timed out, auto-denying", {
          sessionID: input.sessionID,
          permissionID: info.id,
        })
        Bus.publish(Event.Replied, {
          sessionID: input.sessionID,
          permissionID: info.id,
          response: "reject",
        })
        match.reject(
          new RejectedError(
            input.sessionID,
            info.id,
            input.callID,
            input.metadata,
            `Permission request timed out after ${Math.round(ms / 1000)}s with no user response. The user may be away.`,
          ),
        )
      }, ms)

      pending[input.sessionID][info.id] = {
        info,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      Bus.publish(Event.Updated, info)
    })
  }

  export function respond(input: { sessionID: Info["sessionID"]; permissionID: Info["id"]; response: Response }) {
    log.info("response", input)
    const { pending } = state()
    const match = pending[input.sessionID]?.[input.permissionID]
    if (!match) return
    delete pending[input.sessionID][input.permissionID]
    Bus.publish(Event.Replied, {
      sessionID: input.sessionID,
      permissionID: input.permissionID,
      response: input.response,
    })
    if (input.response === "reject") {
      match.reject(new RejectedError(input.sessionID, input.permissionID, match.info.callID, match.info.metadata))
      return
    }

    if (input.response === "session") {
      const memKey = memoryKey(match.info.type, match.info.metadata)
      const memory = state().sessionMemory[input.sessionID] ?? new Set<string>()
      memory.add(memKey)
      state().sessionMemory[input.sessionID] = memory
      log.info("recorded session memory", { sessionID: input.sessionID, key: memKey })
    }
    match.resolve()
  }

  export class RejectedError extends Error {
    constructor(
      public readonly sessionID: string,
      public readonly permissionID: string,
      public readonly toolCallID?: string,
      public readonly metadata?: Record<string, any>,
      public readonly reason?: string,
    ) {
      super(
        reason !== undefined
          ? reason
          : `The user rejected permission to use this specific tool call. You may try again with different parameters.`,
      )
    }
  }

  export function clearSessionMemory(sessionID?: string) {
    if (sessionID) {
      delete state().sessionMemory[sessionID]
    } else {
      for (const key of Object.keys(state().sessionMemory)) {
        delete state().sessionMemory[key]
      }
    }
  }
}
