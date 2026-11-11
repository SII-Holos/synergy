import { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"
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
    const bytes = request.body ? await requestBytes(request, binary ? Desktop.BinaryLimit : 65_536) : undefined
    let body: string | undefined
    if (bytes !== undefined && !binary) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new DesktopOrganizationClientError("invalid_request")
      }
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
