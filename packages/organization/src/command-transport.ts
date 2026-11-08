import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationError, fail } from "./error"

export interface RuntimeConnectionLease {
  readonly handshake: Protocol.Handshake
  assertCurrent(): void
  exchange(command: Command.Delivery, options: { signal: AbortSignal; deadline: number }): Promise<Command.Reply>
}

export function createCommandTransport(input: {
  current(): Protocol.Handshake
  buffered(): number
  send(frame: Runtime.ServerFrame): number
}) {
  const pending = new Map<
    string,
    {
      command: Command.Delivery
      resolve(reply: Command.Reply): void
      reject(error: InstanceType<typeof OrganizationError>): void
    }
  >()

  function failure(outcome: "not_dispatched" | "unknown", message: string) {
    return new OrganizationError({
      code: outcome === "unknown" ? "COMMAND_OUTCOME_UNKNOWN" : "RUNTIME_OFFLINE",
      message,
      outcome,
      retryable: outcome === "not_dispatched",
    })
  }
  function validate(command: Command.Delivery, reply: Command.Reply) {
    if (reply.kind === "error") return
    if (command.kind === "query") {
      if (reply.kind !== "query" || JSON.stringify(reply.query.authorization) !== JSON.stringify(command.authorization))
        fail("PROTOCOL_MISMATCH", "Receipt query response does not match its authorization")
      return
    }
    const permit =
      command.kind === "input" || command.kind === "create"
        ? command.delivery.authorization.permit
        : command.authorization.permit.command
    if (reply.kind !== "result" || JSON.stringify(reply.result.attempt.permit) !== JSON.stringify(permit))
      fail("PROTOCOL_MISMATCH", "Runtime receipt does not match the dispatched attempt")
  }
  return {
    exchange(value: Command.Delivery, options: { signal: AbortSignal; deadline: number }): Promise<Command.Reply> {
      const command = Command.Delivery.parse(value)
      const handshake = input.current()
      if (options.signal.aborted || options.deadline <= Date.now())
        throw failure("not_dispatched", "Command request ended before transmission")
      if (pending.size >= 16 || input.buffered() > 64 * 1024)
        throw failure("not_dispatched", "Runtime command transport is busy; retry the active request")
      const exchangeID = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        function clear() {
          pending.delete(exchangeID)
          clearTimeout(timer)
          options.signal.removeEventListener("abort", cancel)
        }
        function cancel() {
          clear()
          reject(failure("unknown", "Command response was not observed before the request ended"))
        }
        const timer = setTimeout(cancel, Math.min(options.deadline - Date.now(), 2 ** 31 - 1))
        timer.unref()
        options.signal.addEventListener("abort", cancel, { once: true })
        pending.set(exchangeID, {
          command,
          resolve(reply) {
            clear()
            resolve(reply)
          },
          reject(error) {
            clear()
            reject(error)
          },
        })
        try {
          // Provenance: https://bun.sh/docs/runtime/http/websockets#backpressure
          // Bun's -1 is enqueued; only 0 proves a nonempty frame was dropped. Never resend an enqueued frame.
          const sent = input.send({ type: "command", connectionEpoch: handshake.connectionEpoch, exchangeID, command })
          if (sent === 0) {
            clear()
            reject(failure("not_dispatched", "Runtime did not receive the command frame"))
          }
        } catch {
          clear()
          reject(failure("unknown", "Command transmission outcome is unknown"))
        }
      })
    },
    validate(exchangeID: string, reply: Command.Reply) {
      const request = pending.get(exchangeID)
      if (request) validate(request.command, reply)
    },
    resolve(exchangeID: string, reply: Command.Reply) {
      pending.get(exchangeID)?.resolve(reply)
    },
    close() {
      for (const request of pending.values())
        request.reject(failure("unknown", "Runtime connection closed before its receipt arrived"))
    },
  }
}
