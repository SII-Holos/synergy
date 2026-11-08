import { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

export class DesktopOrganizationClientError extends Error {
  constructor(readonly code: Desktop.ErrorCode) {
    super("Organization request failed")
    this.name = "DesktopOrganizationClientError"
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
    const body = request.body ? await request.text() : undefined
    if (body !== undefined && new TextEncoder().encode(body).byteLength > 65_536)
      throw new DesktopOrganizationClientError("invalid_request")
    const parsed = Desktop.Request.safeParse({
      requestID: generateUUID(),
      connectionID: identity.id,
      method: request.method,
      path: url.pathname + url.search,
      ...(body !== undefined ? { body } : {}),
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
      return new Response(response.data.status === 204 ? null : response.data.body, {
        status: response.data.status,
        headers: { "content-type": "application/json" },
      })
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
