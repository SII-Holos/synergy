import { OrganizationClientAuth as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient, type OrgClientTokens } from "@ericsanchezok/synergy-sdk/organization"
import { generateSecureRandomBytes, type UUIDCrypto } from "@ericsanchezok/synergy-util/uuid"

export class OrganizationAuthorizationError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_response"
      | "secure_context_required"
      | "popup_unavailable"
      | "cancelled"
      | "expired"
      | "unavailable",
  ) {
    super("Invalid organization authorization")
    this.name = "OrganizationAuthorizationError"
  }
}

export type AuthorizationPage =
  | { kind: "authorize"; request: Protocol.Authorize }
  | { kind: "callback"; code: ReturnType<typeof Protocol.Code.parse> }

export function consumeAuthorizationLocation(
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState">,
): AuthorizationPage {
  const url = new URL(location.href)
  const fragment = url.hash
  const query = url.search
  url.hash = ""
  url.search = ""
  history.replaceState(null, "", url.href)
  try {
    if (query || fragment.length > 8192) throw new Error()
    const params = new URLSearchParams(fragment.slice(1))
    if ([...params].length !== 1) throw new Error()
    if (params.has("authorize")) {
      const request = Protocol.Authorize.parse(JSON.parse(params.get("authorize")!))
      if (url.href !== `${request.issuer}/organization.html`) throw new Error()
      return { kind: "authorize", request }
    }
    const code = Protocol.Code.parse(JSON.parse(params.get("code")!))
    if (code.redirectUri !== url.href || url.protocol !== "https:") throw new Error()
    return { kind: "callback", code }
  } catch {
    throw new OrganizationAuthorizationError("invalid_request")
  }
}

export function organizationAuthorizationURL(request: Protocol.Authorize) {
  return `${request.issuer}/organization.html#authorize=${encodeURIComponent(JSON.stringify(request))}`
}

export function organizationCallbackURL(input: unknown) {
  const code = Protocol.Code.parse(input)
  Protocol.Client.parse({
    clientID: code.clientID,
    kind: code.redirectUri.startsWith("https:") ? "web" : "desktop",
    redirectUri: code.redirectUri,
  })
  return `${code.redirectUri}#code=${encodeURIComponent(JSON.stringify(code))}`
}

type Popup = { closed: boolean; close(): void; location: { replace(url: string): void } }
type PopupHost = {
  location: { origin: string }
  open(url: string, target: string, features: string): Popup | null
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function sameAuthority(a: ReturnType<typeof Protocol.Authority.parse>, b: ReturnType<typeof Protocol.Authority.parse>) {
  return a.issuer === b.issuer && a.orgID === b.orgID && a.deploymentIncarnation === b.deploymentIncarnation
}

export function authorizeOrganization(options: {
  issuer: string
  orgID?: string
  deploymentIncarnation?: string
  accountID?: string
  clientID: string
  redirectUri: string
  signal?: AbortSignal
  fetch?: typeof fetch
  host?: PopupHost
  crypto?: UUIDCrypto & { subtle?: Pick<SubtleCrypto, "digest"> }
}): Promise<OrgClientTokens> {
  return new Promise((resolve, reject) => {
    const host: PopupHost = options.host ?? window
    const controller = new AbortController()
    let popup: Popup | null = null
    let timer: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let request: Protocol.Authorize | undefined
    let verifier = ""
    let finished = false
    let exchanging = false

    function finish(result: OrgClientTokens | OrganizationAuthorizationError) {
      if (finished) return
      finished = true
      controller.abort()
      verifier = ""
      clearInterval(timer)
      clearTimeout(deadline)
      host.removeEventListener("message", message)
      options.signal?.removeEventListener("abort", cancel)
      try {
        popup?.close()
      } catch {
        /* An isolated or already closed window has no owned resources left. */
      }
      if (result instanceof OrganizationAuthorizationError) reject(result)
      else resolve(result)
    }
    function cancel() {
      finish(new OrganizationAuthorizationError("cancelled"))
    }
    function message(event: MessageEvent) {
      // Bind both origin and window to this transaction; a matching state alone does not identify its sender.
      // https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#security_concerns
      if (finished || exchanging || !request || event.origin !== host.location.origin || event.source !== popup) return
      const body: unknown = event.data
      if (
        !body ||
        typeof body !== "object" ||
        !("type" in body) ||
        body.type !== "synergy.organization.authorization" ||
        !("code" in body)
      )
        return
      const parsed = Protocol.Code.safeParse(body.code)
      if (!parsed.success) return
      const code = parsed.data
      if (
        !sameAuthority(code, request) ||
        code.state !== request.state ||
        code.clientID !== request.clientID ||
        code.redirectUri !== request.redirectUri
      )
        return
      if (code.expiresAt <= Date.now()) return finish(new OrganizationAuthorizationError("expired"))
      exchanging = true
      clearInterval(timer)
      void exchange(code)
    }
    async function exchange(code: ReturnType<typeof Protocol.Code.parse>) {
      try {
        const client = createOrganizationClient({
          baseUrl: code.issuer,
          fetch: options.fetch,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        })
        const response = await client.orgAuth.exchange(
          {
            orgCodeExchangeInput: {
              issuer: code.issuer,
              orgID: code.orgID,
              deploymentIncarnation: code.deploymentIncarnation,
              clientID: code.clientID,
              redirectUri: code.redirectUri,
              code: code.code,
              verifier,
            },
          },
          { signal: controller.signal },
        )
        if (finished) return
        const tokens = Protocol.Tokens.safeParse(response.data)
        if (
          !tokens.success ||
          !sameAuthority(tokens.data, code) ||
          tokens.data.clientID !== code.clientID ||
          tokens.data.account.orgID !== code.orgID ||
          tokens.data.account.state !== "active" ||
          (options.accountID !== undefined && tokens.data.account.accountID !== options.accountID) ||
          tokens.data.expiresAt <= Date.now() ||
          tokens.data.refreshToken !== undefined ||
          tokens.data.refreshExpiresAt !== undefined
        )
          return finish(new OrganizationAuthorizationError("invalid_response"))
        finish(tokens.data)
      } catch {
        finish(new OrganizationAuthorizationError("unavailable"))
      }
    }
    async function prepare(state: string, crypto: NonNullable<typeof options.crypto>) {
      try {
        // RFC 7636 section 4.2: S256 uses the base64url-encoded SHA-256 digest of the ASCII verifier.
        // https://www.rfc-editor.org/rfc/rfc7636#section-4.2
        const digest = await crypto.subtle!.digest("SHA-256", new TextEncoder().encode(verifier))
        if (finished) return
        const client = createOrganizationClient({
          baseUrl: options.issuer,
          fetch: options.fetch,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        })
        const response = await client.orgAuth.discovery({ clientID: options.clientID }, { signal: controller.signal })
        if (finished) return
        const discovery = Protocol.Discovery.safeParse(response.data)
        if (
          !discovery.success ||
          discovery.data.issuer !== options.issuer ||
          discovery.data.client.kind !== "web" ||
          discovery.data.client.clientID !== options.clientID ||
          discovery.data.client.redirectUri !== options.redirectUri ||
          (options.orgID !== undefined && discovery.data.orgID !== options.orgID) ||
          (options.deploymentIncarnation !== undefined &&
            discovery.data.deploymentIncarnation !== options.deploymentIncarnation)
        )
          return finish(new OrganizationAuthorizationError("invalid_response"))
        const { issuer, orgID, deploymentIncarnation } = discovery.data
        request = {
          issuer,
          orgID,
          deploymentIncarnation,
          clientID: options.clientID,
          redirectUri: options.redirectUri,
          state,
          codeChallenge: base64url(new Uint8Array(digest)),
          codeChallengeMethod: "S256",
        }
        popup!.location.replace(organizationAuthorizationURL(request))
      } catch {
        finish(new OrganizationAuthorizationError("unavailable"))
      }
    }
    if (options.signal?.aborted) return cancel()
    const parsed = Protocol.Client.safeParse({
      kind: "web",
      clientID: options.clientID,
      redirectUri: options.redirectUri,
    })
    if (
      !parsed.success ||
      !Protocol.Origin.safeParse(options.issuer).success ||
      new URL(parsed.data.redirectUri).origin !== host.location.origin ||
      (options.orgID === undefined) !== (options.deploymentIncarnation === undefined)
    )
      return finish(new OrganizationAuthorizationError("invalid_request"))
    const crypto = options.crypto ?? globalThis.crypto
    let state: string
    try {
      if (!crypto?.subtle?.digest) throw new Error()
      state = base64url(generateSecureRandomBytes(32, { crypto }))
      verifier = base64url(generateSecureRandomBytes(32, { crypto }))
    } catch {
      return finish(new OrganizationAuthorizationError("secure_context_required"))
    }
    try {
      popup = host.open("about:blank", "_blank", "popup,width=480,height=700")
    } catch {
      /* Surface browser popup restrictions through the same recovery action. */
    }
    if (!popup) return finish(new OrganizationAuthorizationError("popup_unavailable"))
    host.addEventListener("message", message)
    options.signal?.addEventListener("abort", cancel, { once: true })
    timer = setInterval(() => {
      if (popup?.closed) finish(new OrganizationAuthorizationError("popup_unavailable"))
    }, 250)
    deadline = setTimeout(() => finish(new OrganizationAuthorizationError("expired")), 5 * 60_000)
    void prepare(state, crypto)
  })
}
