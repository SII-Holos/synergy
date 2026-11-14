import {
  OrganizationClientAuth as Protocol,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { organizationCallbackURL } from "./authorization"

export class OrganizationApprovalError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_response" | "sign_in_required" | "unavailable") {
    super("Organization authorization could not be completed")
    this.name = "OrganizationApprovalError"
  }
}

export function createOrganizationApproval(options: {
  request: Protocol.Authorize
  origin: string
  fetch?: typeof fetch
  signal?: AbortSignal
}) {
  const parsed = Protocol.Authorize.safeParse(options.request)
  if (!parsed.success || parsed.data.issuer !== options.origin) throw new OrganizationApprovalError("invalid_request")
  const request = parsed.data
  const client = createOrganizationClient({
    baseUrl: request.issuer,
    fetch: options.fetch,
    credentials: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: options.signal,
  })
  let verified = false
  let current: ReturnType<typeof Identity.CurrentSession.parse> | undefined

  function acceptSession(input: unknown) {
    const result = Identity.CurrentSession.safeParse(input)
    if (
      !result.success ||
      result.data.account.orgID !== request.orgID ||
      result.data.account.state !== "active" ||
      result.data.expiresAt <= Date.now()
    )
      throw new OrganizationApprovalError("invalid_response")
    current = result.data
    return current
  }
  function requireSession() {
    if (!verified) throw new OrganizationApprovalError("invalid_request")
    if (!current || current.expiresAt <= Date.now()) throw new OrganizationApprovalError("sign_in_required")
    return { "x-csrf-token": current.csrfToken }
  }
  function checkResponse(response?: Response) {
    if (response?.status === 401) {
      current = undefined
      throw new OrganizationApprovalError("sign_in_required")
    }
    if (!response?.ok) throw new OrganizationApprovalError("unavailable")
    if (options.signal?.aborted) throw new OrganizationApprovalError("unavailable")
  }
  return {
    async load() {
      verified = false
      current = undefined
      const response = await client.orgAuth.discovery({ clientID: request.clientID })
      checkResponse(response.response)
      const discovery = Protocol.Discovery.safeParse(response.data)
      if (
        !discovery.success ||
        discovery.data.issuer !== request.issuer ||
        discovery.data.orgID !== request.orgID ||
        discovery.data.deploymentIncarnation !== request.deploymentIncarnation ||
        discovery.data.client.clientID !== request.clientID ||
        discovery.data.client.redirectUri !== request.redirectUri
      )
        throw new OrganizationApprovalError("invalid_request")
      verified = true
      const session = await client.orgAuth.session()
      if (session.response?.status === 401) return undefined
      checkResponse(session.response)
      return acceptSession(session.data)
    },
    async login(input: Identity.Login) {
      if (!verified) throw new OrganizationApprovalError("invalid_request")
      const result = await client.orgAuth.login({ orgLoginInput: input })
      checkResponse(result.response)
      return acceptSession(result.data)
    },
    async approve() {
      const headers = requireSession()
      const result = await client.orgAuth.authorize({ orgAuthorizeInput: request }, { headers })
      checkResponse(result.response)
      const code = Protocol.Code.safeParse(result.data)
      if (
        !code.success ||
        code.data.issuer !== request.issuer ||
        code.data.orgID !== request.orgID ||
        code.data.deploymentIncarnation !== request.deploymentIncarnation ||
        code.data.clientID !== request.clientID ||
        code.data.redirectUri !== request.redirectUri ||
        code.data.state !== request.state ||
        code.data.expiresAt <= Date.now()
      )
        throw new OrganizationApprovalError("invalid_response")
      return organizationCallbackURL(code.data)
    },
    async logout() {
      const headers = requireSession()
      const result = await client.orgAuth.logout({ orgEmptyInput: {} }, { headers })
      if (result.response?.status === 401) {
        current = undefined
        return
      }
      checkResponse(result.response)
      if (!Identity.Success.safeParse(result.data).success) throw new OrganizationApprovalError("invalid_response")
      current = undefined
    },
  }
}
