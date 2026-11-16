import { createHash } from "node:crypto"
import {
  OrganizationCommandProtocol as Command,
  OrganizationCommandStream as Stream,
  OrganizationDesktop as Desktop,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationError as Failure } from "./error.js"

export type DesktopCommandLease = { signal: AbortSignal; release(): void; abort(): void; current(): boolean }
type Pending = {
  begin: Stream.Begin
  connection: Desktop.Connection
  lease: DesktopCommandLease
  offset: number
  parts: Buffer[]
  hash: ReturnType<typeof createHash>
  phase: "buffering" | "sending"
  busy: boolean
  cancel: () => void
}
const sameConnection = (left: Desktop.Connection, right: Desktop.Connection) =>
  left.id === right.id &&
  left.issuer === right.issuer &&
  left.clientID === right.clientID &&
  left.orgID === right.orgID &&
  left.deploymentIncarnation === right.deploymentIncarnation &&
  left.account.accountID === right.account.accountID
async function wait<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Failure("cancelled")
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Failure("cancelled"))
  })
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([operation(), cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

export class DesktopOrganizationCommandStream {
  private pending = new Map<string, Pending>()
  private bytes = 0
  constructor(
    private options: {
      reserve(requestID: string, connectionID: string, current: () => boolean): DesktopCommandLease
      connection(connectionID: string): Promise<Desktop.Connection>
      submit(
        connectionID: string,
        command: Command.InputRequest | Command.DecisionRequest,
        signal: AbortSignal,
        current: () => boolean,
      ): Promise<Desktop.JsonResponse>
    },
  ) {}
  private close(value: Pending, abort = false) {
    if (this.pending.get(value.begin.requestID) !== value) return
    this.pending.delete(value.begin.requestID)
    value.lease.signal.removeEventListener("abort", value.cancel)
    this.bytes -= value.offset
    value.parts = []
    if (abort) value.lease.abort()
    value.lease.release()
  }
  private assert(value: Pending, current: () => boolean) {
    if (!current() || !value.lease.current() || value.lease.signal.aborted) throw new Failure("cancelled")
  }
  async handle(input: unknown, current: () => boolean): Promise<Desktop.CommandStreamReply> {
    const parsed = Stream.Frame.safeParse(input)
    if (!parsed.success) throw new Failure("invalid_request")
    const frame = parsed.data
    if (frame.type === "begin") {
      const lease = this.options.reserve(frame.requestID, frame.connectionID, current)
      try {
        const connection = await wait(lease.signal, () => this.options.connection(frame.connectionID))
        if (!current() || !lease.current() || lease.signal.aborted) throw new Failure("cancelled")
        if (connection.orgID !== frame.header.orgID) throw new Failure("identity_changed")
        const value: Pending = {
          begin: frame,
          connection,
          lease,
          offset: 0,
          parts: [],
          hash: createHash("sha256"),
          phase: "buffering",
          busy: false,
          cancel: () => this.close(value),
        }
        this.pending.set(frame.requestID, value)
        lease.signal.addEventListener("abort", value.cancel, { once: true })
        return { kind: "progress", requestID: frame.requestID, nextOffset: 0 }
      } catch (error) {
        lease.abort()
        lease.release()
        throw error
      }
    }
    const value = this.pending.get(frame.requestID)
    if (!value) throw new Failure("invalid_request")
    if (value.busy) throw new Failure("request_in_progress")
    value.busy = true
    try {
      this.assert(value, current)
      if (frame.connectionID !== value.begin.connectionID) throw new Failure("identity_changed")
      const connection = await wait(value.lease.signal, () => this.options.connection(frame.connectionID))
      this.assert(value, current)
      if (!sameConnection(connection, value.connection)) throw new Failure("identity_changed")
      if (value.phase !== "buffering") throw new Failure("request_in_progress")
      if (frame.type === "chunk") {
        const bytes = Buffer.from(frame.data, "base64url")
        if (
          frame.offset !== value.offset ||
          bytes.toString("base64url") !== frame.data ||
          bytes.byteLength !== Math.min(Runtime.commandChunkBytes, value.begin.bytes - value.offset)
        )
          throw new Failure("invalid_request")
        if (this.bytes + bytes.byteLength > 64 * 1024 * 1024) throw new Failure("unavailable")
        value.parts.push(bytes)
        value.hash.update(bytes)
        value.offset += bytes.byteLength
        this.bytes += bytes.byteLength
        return { kind: "progress", requestID: frame.requestID, nextOffset: value.offset }
      }
      if (value.offset !== value.begin.bytes || value.hash.digest("hex") !== value.begin.sha256)
        throw new Failure("invalid_request")
      value.phase = "sending"
      let command: Command.InputRequest | Command.DecisionRequest
      try {
        const payload: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(value.parts)),
        )
        command =
          value.begin.operation === "input"
            ? Command.InputRequest.parse({ ...value.begin.header, input: payload })
            : Command.DecisionRequest.parse({ ...value.begin.header, decision: payload })
      } catch {
        throw new Failure("invalid_request")
      }
      value.parts = []
      const response = await wait(value.lease.signal, () =>
        this.options.submit(
          value.begin.connectionID,
          command,
          value.lease.signal,
          () => current() && value.lease.current(),
        ),
      )
      this.assert(value, current)
      return { kind: "response", requestID: frame.requestID, response: Desktop.JsonResponse.parse(response) }
    } catch (error) {
      this.close(value, true)
      throw error
    } finally {
      value.busy = false
      if (frame.type === "finish") this.close(value)
    }
  }
}
