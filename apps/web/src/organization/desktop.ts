import {
  OrganizationDesktop as Desktop,
  OrganizationCommandProtocol as Command,
  OrganizationCommandStream as Stream,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { sha256 } from "@noble/hashes/sha256"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

export class DesktopOrganizationClientError extends Error {
  constructor(readonly code: Desktop.ErrorCode) {
    super("Organization request failed")
    this.name = "DesktopOrganizationClientError"
  }
}

async function requestBytes(request: Request, limit: number) {
  const reader = request.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  request.signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new DesktopOrganizationClientError("invalid_request")
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    request.signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function streamCommand(
  bridge: Desktop.Bridge,
  connection: Desktop.Connection,
  request: Request,
  command: Command.InputRequest | Command.DecisionRequest,
): Promise<Desktop.JsonResponse> {
  const encoded = Stream.serialize(command)
  const requestID = generateUUID()
  const identity = { requestID, connectionID: connection.id }
  let completed = false
  let stop!: () => void
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      void bridge.cancel({ requestID }).catch(() => {})
      reject(new DOMException("The request was cancelled", "AbortError"))
    }
  })
  void aborted.catch(() => {})
  request.signal.addEventListener("abort", stop, { once: true })
  async function send(frame: Stream.Frame) {
    if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
    const result = await Promise.race([bridge.commandStream(frame), aborted])
    if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
    if (!result.ok) throw new DesktopOrganizationClientError(result.error.code)
    const parsed = Desktop.CommandStreamReply.safeParse(result.value)
    if (!parsed.success || parsed.data.requestID !== requestID)
      throw new DesktopOrganizationClientError("invalid_response")
    return parsed.data
  }
  try {
    const initial = await send(
      Stream.Begin.parse({
        type: "begin",
        ...identity,
        operation: encoded.operation,
        header: encoded.header,
        bytes: encoded.payload.byteLength,
        sha256: Array.from(sha256(encoded.payload), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      }),
    )
    if (initial.kind !== "progress" || initial.nextOffset !== 0)
      throw new DesktopOrganizationClientError("invalid_response")
    for (let offset = 0; offset < encoded.payload.byteLength; offset += Runtime.commandChunkBytes) {
      const bytes = encoded.payload.subarray(offset, offset + Runtime.commandChunkBytes)
      const result = await send({ type: "chunk", ...identity, offset, data: Stream.encodeChunk(bytes) })
      if (result.kind !== "progress" || result.nextOffset !== offset + bytes.byteLength)
        throw new DesktopOrganizationClientError("invalid_response")
    }
    const result = await send({ type: "finish", ...identity })
    if (result.kind !== "response") throw new DesktopOrganizationClientError("invalid_response")
    completed = true
    return result.response
  } finally {
    request.signal.removeEventListener("abort", stop)
    if (!completed) void bridge.cancel({ requestID }).catch(() => {})
  }
}

export function desktopOrganizationFetch(bridge: Desktop.Bridge, connection: Desktop.Connection): typeof fetch {
  const identity = Desktop.Connection.parse(connection)
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const request = new Request(input, init)
    const headers = new Headers(init?.headers ?? request.headers)
    if (
      url.origin !== identity.issuer ||
      url.username ||
      url.password ||
      url.hash ||
      headers.has("authorization") ||
      headers.has("cookie") ||
      headers.has("origin")
    )
      throw new DesktopOrganizationClientError("invalid_request")
    if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
    const binary = request.body && headers.get("content-type") === "application/octet-stream"
    const commandRoute =
      request.method === "POST" && !url.search
        ? /^\/org\/v1\/sessions\/([a-zA-Z0-9_-]+)\/(commands|interactions\/reply)$/.exec(url.pathname)
        : null
    const commandLimit = commandRoute?.[2] === "commands" ? Command.inputByteLimit : Command.decisionByteLimit
    const bytes = request.body
      ? await requestBytes(
          request,
          binary ? Desktop.BinaryLimit : commandRoute ? commandLimit + Desktop.ControlLimit : Desktop.ControlLimit,
        )
      : undefined
    let body: string | undefined
    if (bytes !== undefined && !binary) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new DesktopOrganizationClientError("invalid_request")
      }
    }
    if (commandRoute && !binary) {
      let command: Command.InputRequest | Command.DecisionRequest
      try {
        const value: unknown = JSON.parse(body ?? "")
        command =
          commandRoute[2] === "commands" ? Command.InputRequest.parse(value) : Command.DecisionRequest.parse(value)
      } catch {
        throw new DesktopOrganizationClientError("invalid_request")
      }
      if (command.sessionID !== commandRoute[1] || command.orgID !== identity.orgID)
        throw new DesktopOrganizationClientError("invalid_request")
      const result = await streamCommand(bridge, identity, request, command)
      return new Response(result.status === 204 ? null : result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      })
    }
    const parsed = Desktop.Request.safeParse({
      requestID: generateUUID(),
      connectionID: identity.id,
      method: request.method,
      path: url.pathname + url.search,
      ...(body !== undefined ? { body } : {}),
      ...(binary ? { bodyBytes: bytes, contentType: "application/octet-stream" } : {}),
      ...(headers.has("range") ? { range: headers.get("range") } : {}),
    })
    if (!parsed.success) throw new DesktopOrganizationClientError("invalid_request")
    const cancel = () => {
      void bridge.cancel({ requestID: parsed.data.requestID }).catch(() => {})
    }
    request.signal.addEventListener("abort", cancel, { once: true })
    try {
      if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
      const result = await bridge.request(parsed.data)
      if (request.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
      if (!result.ok) throw new DesktopOrganizationClientError(result.error.code)
      const response = Desktop.Response.safeParse(result.value)
      if (!response.success) throw new DesktopOrganizationClientError("invalid_response")
      const binaryResponse = "bodyBytes" in response.data ? response.data : undefined
      return new Response(
        response.data.status === 204
          ? null
          : binaryResponse
            ? binaryResponse.bodyBytes
            : "body" in response.data
              ? response.data.body
              : null,
        {
          status: response.data.status,
          headers: {
            "content-type": binaryResponse?.contentType ?? "application/json",
            ...(binaryResponse?.contentRange ? { "content-range": binaryResponse.contentRange } : {}),
          },
        },
      )
    } finally {
      request.signal.removeEventListener("abort", cancel)
    }
  }
  return Object.assign(transport, { preconnect() {} })
}

export function createDesktopOrganizationClient(bridge: Desktop.Bridge, connection: Desktop.Connection) {
  return createOrganizationClient({
    baseUrl: connection.issuer,
    fetch: desktopOrganizationFetch(bridge, connection),
    credentials: "omit",
    redirect: "error",
  })
}
