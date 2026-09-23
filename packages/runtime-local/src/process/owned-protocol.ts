import { z } from "zod"
import type { Socket } from "node:net"

export namespace OwnedProtocol {
  export const Configuration = z.object({
    socket: z.union([z.string(), z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65535) })]),
    token: z.string(),
    deadline: z.number(),
    ownerCoalition: z.object({ bootID: z.string(), coalitionID: z.string() }).optional(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    pty: z
      .object({
        cols: z.number().int().min(1).max(65535),
        rows: z.number().int().min(1).max(65535),
        library: z.string(),
      })
      .optional(),
  })
  export type Configuration = z.infer<typeof Configuration>
  export const Greeting = z.object({
    token: z.string(),
    channel: z.enum(["control", "stdin", "stdout", "stderr"]),
    pid: z.number().int().positive(),
  })
  export const Event = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready"), pid: z.number().int().positive() }),
    z.object({ type: z.literal("exit"), code: z.number().int().nullable(), signal: z.string().nullable() }),
    z.object({ type: z.literal("error"), message: z.string() }),
  ])
  export type Event = z.infer<typeof Event>
  export const Control = z.discriminatedUnion("type", [
    z.object({ type: z.literal("activate") }),
    z.object({
      type: z.literal("resize"),
      cols: z.number().int().min(1).max(65535),
      rows: z.number().int().min(1).max(65535),
    }),
  ])
  export function send(socket: Socket, value: unknown) {
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > 8192) throw new Error("Native process control message exceeds its bound")
    socket.write(`${data}\n`)
  }
  export function messages(socket: Socket, receive: (value: unknown) => void, failed: (error: Error) => void) {
    let pending = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      try {
        pending += data
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n")
          if (Buffer.byteLength(pending.slice(0, end)) > 8192)
            throw new Error("Native process control message exceeds its bound")
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          receive(JSON.parse(line))
        }
        if (Buffer.byteLength(pending) > 8192) throw new Error("Native process control message exceeds its bound")
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
