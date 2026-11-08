import { createHash, randomBytes } from "node:crypto"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationClientAuth as Auth,
  OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"
import type { DesktopOrganizationAccounts } from "./accounts.js"
import { DesktopOrganizationError as Failure } from "./error.js"

type Code = ReturnType<typeof Auth.Code.parse>
type Pending = {
  target: Desktop.Connect
  request?: Auth.Authorize
  exchange(code: Code): Promise<void>
  cancel(): void
  exchanging: boolean
}
const redirectUri = "synergy://organization-auth/callback"

function sameAuthority(a: ReturnType<typeof Auth.Authority.parse>, b: ReturnType<typeof Auth.Authority.parse>) {
  return a.issuer === b.issuer && a.orgID === b.orgID && a.deploymentIncarnation === b.deploymentIncarnation
}

export class DesktopOrganizationAuthorization {
  private pending = new Map<string, Pending>()
  private disposed = false

  constructor(
    private options: {
      accounts: DesktopOrganizationAccounts
      fetch?: typeof fetch
      openExternal(url: string): Promise<void>
    },
  ) {}

  authorize(
    input: unknown,
    options: { signal?: AbortSignal; current?: () => boolean } = {},
  ): Promise<Desktop.Connection> {
    const parsed = Desktop.Connect.safeParse(input)
    if (!parsed.success) return Promise.reject(new Failure("invalid_request"))
    if (this.disposed || options.signal?.aborted) return Promise.reject(new Failure("cancelled"))
    const target = parsed.data
    return new Promise((resolve, reject) => {
      const state = randomBytes(32).toString("base64url")
      let verifier = randomBytes(32).toString("base64url")
      const controller = new AbortController()
      const client = createOrganizationClient({
        baseUrl: target.issuer,
        fetch: this.options.fetch,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      })
      let finished = false
      const current = () => !finished && !this.disposed && !controller.signal.aborted && (options.current?.() ?? true)
      const ensure = () => {
        if (!current()) throw new Failure("cancelled")
      }
      const cancel = () => finish(new Failure("cancelled"))
      const timeout = setTimeout(() => finish(new Failure("expired")), 300_000)
      timeout.unref()
      const finish = (result: Desktop.Connection | Failure) => {
        if (finished) return
        finished = true
        verifier = ""
        controller.abort()
        clearTimeout(timeout)
        options.signal?.removeEventListener("abort", cancel)
        this.pending.delete(state)
        if (result instanceof Failure) reject(result)
        else resolve(result)
      }
      const pending: Pending = {
        target,
        cancel,
        exchanging: false,
        exchange: async (code) => {
          if (!current()) return cancel()
          if (pending.exchanging) return
          pending.exchanging = true
          try {
            if (code.expiresAt <= Date.now()) throw new Failure("expired")
            const response = await client.orgAuth.exchange(
              {
                orgCodeExchangeInput: {
                  issuer: target.issuer,
                  orgID: code.orgID,
                  deploymentIncarnation: code.deploymentIncarnation,
                  clientID: target.clientID,
                  redirectUri,
                  code: code.code,
                  verifier,
                },
              },
              { signal: controller.signal },
            )
            ensure()
            if (!response.response.ok) throw new Failure("unavailable")
            const tokens = Auth.Tokens.safeParse(response.data)
            if (!tokens.success) throw new Failure("invalid_response")
            if (
              !sameAuthority(tokens.data, code) ||
              tokens.data.clientID !== target.clientID ||
              (target.expected?.accountID && tokens.data.account.accountID !== target.expected.accountID)
            )
              throw new Failure("identity_changed")
            const accepted = await this.options.accounts.accept(tokens.data, current)
            ensure()
            finish(accepted)
          } catch (error) {
            finish(error instanceof Failure ? error : new Failure("unavailable"))
          }
        },
      }
      this.pending.set(state, pending)
      options.signal?.addEventListener("abort", cancel, { once: true })
      void (async () => {
        try {
          ensure()
          const response = await client.orgAuth.discovery({ clientID: target.clientID }, { signal: controller.signal })
          ensure()
          if (!response.response.ok) throw new Failure("unavailable")
          const result = Auth.Discovery.safeParse(response.data)
          if (!result.success) throw new Failure("invalid_response")
          const discovery = result.data
          if (
            discovery.issuer !== target.issuer ||
            discovery.client.clientID !== target.clientID ||
            discovery.client.kind !== "desktop" ||
            discovery.client.redirectUri !== redirectUri ||
            (target.expected &&
              (target.expected.orgID !== discovery.orgID ||
                target.expected.deploymentIncarnation !== discovery.deploymentIncarnation))
          )
            throw new Failure("identity_changed")
          const request: Auth.Authorize = {
            issuer: target.issuer,
            orgID: discovery.orgID,
            deploymentIncarnation: discovery.deploymentIncarnation,
            clientID: target.clientID,
            redirectUri,
            state,
            codeChallengeMethod: "S256",
            codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          }
          pending.request = request
          ensure()
          await this.options.openExternal(
            `${target.issuer}/organization.html#authorize=${encodeURIComponent(JSON.stringify(request))}`,
          )
          ensure()
        } catch (error) {
          finish(error instanceof Failure ? error : new Failure("unavailable"))
        }
      })()
    })
  }

  async callback(address: string): Promise<boolean> {
    let url: URL
    try {
      url = new URL(address)
    } catch {
      return false
    }
    if (url.protocol !== "synergy:" || url.hostname !== "organization-auth") return false
    try {
      const fragment = url.hash
      url.hash = ""
      if (url.href !== redirectUri || fragment.length > 8192) return true
      const params = new URLSearchParams(fragment.slice(1))
      if ([...params].length !== 1 || !params.has("code")) return true
      const code = Auth.Code.parse(JSON.parse(params.get("code")!))
      const pending = this.pending.get(code.state)
      if (
        !pending?.request ||
        !sameAuthority(code, pending.request) ||
        code.clientID !== pending.request.clientID ||
        code.redirectUri !== redirectUri
      )
        return true
      await pending.exchange(code)
    } catch {
      return true
    }
    return true
  }

  cancel(connection?: Desktop.Connection) {
    for (const pending of this.pending.values()) {
      if (
        connection &&
        (pending.target.issuer !== connection.issuer ||
          (pending.target.expected?.accountID && pending.target.expected.accountID !== connection.account.accountID))
      )
        continue
      pending.cancel()
    }
  }

  dispose() {
    this.disposed = true
    this.cancel()
  }
}
