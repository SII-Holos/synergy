import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import {
  COMPUTER_PROTOCOL_VERSION,
  ComputerHostMessageSchema,
  ComputerError,
  type ComputerCommand,
  type ComputerResult,
} from "@ericsanchezok/synergy-computer"

interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
}
type Pending = { resolve(result: ComputerResult): void; reject(error: Error): void; cleanup(): void }

export class ComputerBroker {
  private host?: Socket
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly token: string) {}

  attach(socket: Socket, input: unknown) {
    const message = ComputerHostMessageSchema.parse(input)
    if (
      message.type !== "register" ||
      !/^[a-f0-9]{64}$/.test(this.token) ||
      !timingSafeEqual(Buffer.from(message.token, "hex"), Buffer.from(this.token, "hex"))
    ) {
      throw new ComputerError("computer_host_auth", "Invalid Computer host registration.")
    }
    if (this.host) throw new ComputerError("computer_host_connected", "A Computer host is already connected.")
    socket.send(JSON.stringify({ type: "registered", version: COMPUTER_PROTOCOL_VERSION }))
    this.host = socket
  }

  handle(socket: Socket, input: unknown) {
    if (socket !== this.host) return
    const message = ComputerHostMessageSchema.parse(input)
    if (message.type === "register")
      throw new ComputerError("computer_host_protocol", "Computer host is already registered.")
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    pending.cleanup()
    if (message.type === "error")
      pending.reject(new ComputerError(message.code ?? "computer_host_error", message.message))
    else pending.resolve(message.result)
  }

  detach(socket: Socket) {
    if (socket !== this.host) return
    this.host = undefined
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(
        new ComputerError(
          "computer_host_disconnected",
          "Computer host disconnected. Observe again after reconnecting; the previous action may have taken effect.",
        ),
      )
    }
    this.pending.clear()
  }

  execute(owner: string, command: ComputerCommand, signal?: AbortSignal): Promise<ComputerResult> {
    signal?.throwIfAborted()
    const host = this.host
    if (!host)
      return Promise.reject(
        new ComputerError("computer_host_unavailable", "Computer Use requires a connected local Synergy Desktop host."),
      )
    if (this.pending.size >= 64)
      return Promise.reject(
        new ComputerError("computer_capacity", "Computer host is busy. Retry after pending operations finish."),
      )
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        try {
          host.send(JSON.stringify({ type: "cancel", id }))
        } catch {}
        reject(error)
      }
      const abort = () =>
        cancel(
          new ComputerError(
            "computer_cancelled",
            "Computer operation cancelled. Observe before retrying; the action may have taken effect.",
          ),
        )
      const timer = setTimeout(
        () =>
          cancel(
            new ComputerError(
              "computer_timeout",
              "Computer operation timed out. Observe before retrying; the action may have taken effect.",
            ),
          ),
        45_000,
      )
      timer.unref()
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        host.send(JSON.stringify({ type: "command", id, owner, command }))
      } catch {
        cancel(
          new ComputerError(
            "computer_host_disconnected",
            "Computer host disconnected while dispatching the operation.",
          ),
        )
      }
    })
  }
}

export const computerBroker = new ComputerBroker(
  process.env.SYNERGY_COMPUTER_HOST_REGISTRATION_SECRET ?? randomBytes(32).toString("hex"),
)
