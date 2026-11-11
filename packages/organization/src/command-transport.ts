import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationReadProtocol as Read,
  OrganizationInteractionProtocol as Interactions,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationError, fail } from "./error"

const commandChunkBytes = Runtime.commandChunkBytes

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
  const reserved = { command: 0, reconciliation: 0, read: 0 }
  let closed = false
  const waiters = new Set<{
    command: Command.Delivery
    signal: AbortSignal
    deadline: number
    resolve(release: () => void): void
    reject(error: InstanceType<typeof OrganizationError>): void
    timer?: ReturnType<typeof setTimeout>
    cancel(): void
  }>()

  function failure(outcome: "not_dispatched" | "unknown", message: string) {
    return new OrganizationError({
      code: outcome === "unknown" ? "COMMAND_OUTCOME_UNKNOWN" : "RUNTIME_OFFLINE",
      message,
      outcome,
      retryable: outcome === "not_dispatched",
    })
  }
  function window(command: Command.Delivery) {
    if (command.kind === "read" || command.kind === "interactions" || command.kind === "handoff") return "read"
    return command.kind === "query" || command.kind === "skip" ? "reconciliation" : "command"
  }
  function available(command: Command.Delivery) {
    const kind = window(command)
    const occupied = [...pending.values()].filter((request) => window(request.command) === kind).length
    return occupied + reserved[kind] < (kind === "read" ? 4 : 16) && input.buffered() <= 64 * 1024
  }
  function reserve(command: Command.Delivery) {
    const kind = window(command)
    reserved[kind]++
    let released = false
    return () => {
      if (released) return
      released = true
      reserved[kind]--
    }
  }
  function wake() {
    if (closed) return
    for (const waiter of waiters) {
      if (waiter.signal.aborted || waiter.deadline <= Date.now()) continue
      if (!available(waiter.command)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.signal.removeEventListener("abort", waiter.cancel)
      waiter.resolve(reserve(waiter.command))
    }
  }
  async function waitForCapacity(
    command: Command.Delivery,
    options: { signal: AbortSignal; deadline: number },
  ): Promise<() => void> {
    if (closed) throw failure("not_dispatched", "Runtime connection closed before command transmission")
    if (options.signal.aborted || options.deadline <= Date.now())
      throw failure("not_dispatched", "Command request ended before transmission")
    if (available(command)) return reserve(command)
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        command,
        signal: options.signal,
        deadline: options.deadline,
        resolve,
        reject,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        cancel: () => {
          waiters.delete(waiter)
          clearTimeout(waiter.timer)
          options.signal.removeEventListener("abort", waiter.cancel)
          reject(failure("not_dispatched", "Command request ended while waiting for transport capacity"))
        },
      }
      const check = () => {
        if (!waiters.has(waiter)) return
        if (options.signal.aborted || options.deadline <= Date.now()) return waiter.cancel()
        if (available(command)) {
          waiters.delete(waiter)
          options.signal.removeEventListener("abort", waiter.cancel)
          waiter.resolve(reserve(command))
          return
        }
        waiter.timer = setTimeout(check, Math.min(25, Math.max(1, options.deadline - Date.now())))
        waiter.timer.unref()
      }
      waiters.add(waiter)
      options.signal.addEventListener("abort", waiter.cancel, { once: true })
      check()
    })
  }
  function validate(command: Command.Delivery, reply: Command.Reply) {
    if (reply.kind === "error") return
    if (command.kind === "handoff") {
      if (
        reply.kind !== "handoff" ||
        JSON.stringify(reply.authorization) !== JSON.stringify(command.authorization) ||
        !Handoff.matchesMachine(command.authorization.plan, reply.result)
      )
        fail("PROTOCOL_MISMATCH", "Handoff machine response does not match its authorization")
      return
    }
    if (command.kind === "interactions") {
      if (
        reply.kind !== "interactions" ||
        JSON.stringify(reply.authorization) !== JSON.stringify(command.authorization) ||
        !Interactions.matches(command.authorization.permit.query, reply.result, command.authorization.permit.binding)
      )
        fail("PROTOCOL_MISMATCH", "Interaction response does not match its authorization")
      return
    }
    if (command.kind === "read") {
      if (
        reply.kind !== "read" ||
        JSON.stringify(reply.authorization) !== JSON.stringify(command.authorization) ||
        !Read.matches(command.authorization.permit.query, reply.result, Read.bindingFor(command.authorization.permit))
      )
        fail("PROTOCOL_MISMATCH", "Private read response does not match its authorization")
      return
    }
    if (command.kind === "query") {
      if (reply.kind !== "query" || JSON.stringify(reply.query.authorization) !== JSON.stringify(command.authorization))
        fail("PROTOCOL_MISMATCH", "Receipt query response does not match its authorization")
      return
    }
    const permit =
      command.kind === "input" || command.kind === "create" || command.kind === "control" || command.kind === "decision"
        ? command.delivery.authorization.permit
        : command.authorization.permit.command
    if (reply.kind !== "result" || JSON.stringify(reply.result.attempt.permit) !== JSON.stringify(permit))
      fail("PROTOCOL_MISMATCH", "Runtime receipt does not match the dispatched attempt")
  }
  return {
    async exchange(
      value: Command.Delivery,
      options: { signal: AbortSignal; deadline: number },
    ): Promise<Command.Reply> {
      const command = Command.Delivery.parse(value)
      const release = await waitForCapacity(command, options)
      let handshake: Protocol.Handshake
      let exchangeID: string
      try {
        if (closed || options.signal.aborted)
          throw failure("not_dispatched", "Command request ended before transmission")
        handshake = input.current()
        exchangeID = crypto.randomUUID()
      } catch (error) {
        release()
        throw error
      }
      return new Promise((resolve, reject) => {
        function clear() {
          pending.delete(exchangeID)
          clearTimeout(timer)
          options.signal.removeEventListener("abort", cancel)
          wake()
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
        release()
        try {
          const payload = new TextEncoder().encode(JSON.stringify(command))
          const send = (frame: Runtime.ServerFrame) => {
            // Provenance: https://bun.sh/docs/runtime/http/websockets#backpressure
            // Bun's -1 is enqueued; only 0 proves a nonempty frame was dropped. Never resend an enqueued frame.
            return input.send(frame)
          }
          if (payload.byteLength <= commandChunkBytes) {
            const sent = send({ type: "command", connectionEpoch: handshake.connectionEpoch, exchangeID, command })
            if (sent === 0) {
              clear()
              reject(failure("not_dispatched", "Runtime did not receive the command frame"))
            }
          } else {
            const total = Math.ceil(payload.byteLength / commandChunkBytes)
            let enqueued = false
            for (let index = 0; index < total; index++) {
              const start = index * commandChunkBytes
              const data = Buffer.from(
                payload.subarray(start, Math.min(payload.byteLength, start + commandChunkBytes)),
              ).toString("base64url")
              const sent = send({
                type: "command-chunk",
                connectionEpoch: handshake.connectionEpoch,
                exchangeID,
                index,
                total,
                data,
              })
              if (sent === 0) {
                clear()
                reject(failure(enqueued ? "unknown" : "not_dispatched", "Runtime did not receive the command frame"))
                return
              }
              enqueued = true
            }
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
      if (closed) return
      closed = true
      for (const request of pending.values())
        request.reject(failure("unknown", "Runtime connection closed before its receipt arrived"))
      for (const waiter of waiters) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.signal.removeEventListener("abort", waiter.cancel)
        waiter.reject(failure("not_dispatched", "Runtime connection closed before command transmission"))
      }
    },
  }
}
