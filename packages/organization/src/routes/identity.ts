import { Hono, type Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { OrganizationIdentity as Identity, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import type { Authentication, Credentials } from "../auth"
import { OrganizationProjects as Projects } from "../projects"
import { fail } from "../error"

const cookie = "__Host-synergy_org_session"
const accountParam = z.strictObject({ accountID: Identity.ID })
const projectParam = z.strictObject({ projectID: Identity.ID })
const memberParam = projectParam.extend({ accountID: Identity.ID })
const cookieOptions = { secure: true, httpOnly: true, sameSite: "Lax" as const, path: "/" }
function validation(result: { success: boolean }) {
  if (!result.success) fail("INVALID_REQUEST", "Invalid request")
}

function operation(id: string, summary: string, schema: z.ZodType, body = false) {
  const error = {
    description: "Organization error",
    content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
  }
  return describeRoute({
    operationId: id,
    summary,
    requestBody: body ? { required: true, content: { "application/json": {} } } : undefined,
    responses: {
      200: { description: "Success", content: { "application/json": { schema: resolver(schema) } } },
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      503: error,
    },
  })
}

export function identityRoutes(authentication: () => Authentication, publicOrigin?: string) {
  function checkOrigin(c: Context) {
    if (!publicOrigin) fail("SERVICE_UNAVAILABLE", "The organization public origin is not configured")
    if (c.req.header("origin") !== publicOrigin) fail("PERMISSION_DENIED", "The request origin is not allowed")
  }
  // Provenance: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  // Local adaptation: revocable opaque cookies plus an exact configured Origin and session-bound CSRF token.
  function credentials(c: Context): Credentials {
    const token = getCookie(c, cookie)
    if (!token || !Identity.Token.safeParse(token).success)
      fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return { token }
    checkOrigin(c)
    const csrf = c.req.header("x-csrf-token")
    if (!csrf || !Identity.Token.safeParse(csrf).success) fail("PERMISSION_DENIED", "Invalid request token")
    return { token, csrf }
  }
  return new Hono()
    .post(
      "/setup/bootstrap",
      operation("orgSetup.bootstrap", "Initialize the organization once", Identity.Account, true),
      validator("json", Identity.Bootstrap, validation),
      async (c) => {
        checkOrigin(c)
        return c.json(await authentication().bootstrap(c.req.valid("json")))
      },
    )
    .post(
      "/auth/login",
      operation("orgAuth.login", "Sign in with a revocable browser session", Identity.LoginResult, true),
      validator("json", Identity.Login, validation),
      async (c) => {
        checkOrigin(c)
        const { token, ...result } = await authentication().login(c.req.valid("json"))
        setCookie(c, cookie, token, { ...cookieOptions, expires: new Date(result.expiresAt) })
        return c.json(result)
      },
    )
    .get(
      "/auth/session",
      operation("orgAuth.session", "Read the current login session", Identity.CurrentSession),
      async (c) => c.json(await authentication().current(credentials(c))),
    )
    .post(
      "/auth/logout",
      operation("orgAuth.logout", "Revoke this login session", Identity.Success, true),
      validator("json", Identity.Empty, validation),
      async (c) => {
        const result = await authentication().logout(credentials(c))
        deleteCookie(c, cookie, cookieOptions)
        return c.json(result)
      },
    )
    .post(
      "/auth/password",
      operation("orgAuth.password", "Change password and revoke existing logins", Identity.Success, true),
      validator("json", Identity.PasswordChange, validation),
      async (c) => c.json(await authentication().password(credentials(c), c.req.valid("json"))),
    )
    .post(
      "/invites",
      operation("orgInvites.create", "Create a one-time invitation", Identity.TokenResult, true),
      validator("json", Identity.InviteCreate, validation),
      async (c) => c.json(await authentication().invite(credentials(c), c.req.valid("json"))),
    )
    .post(
      "/invites/consume",
      operation("orgInvites.consume", "Join using an invitation", Identity.Account, true),
      validator("json", Identity.InviteConsume, validation),
      async (c) => {
        checkOrigin(c)
        return c.json(await authentication().consumeInvite(c.req.valid("json")))
      },
    )
    .get(
      "/organization",
      operation("orgOrganization.get", "Read organization identity", Identity.Organization),
      async (c) => c.json(await authentication().organization(credentials(c))),
    )
    .post(
      "/organization/transfer-owner",
      operation("orgOrganization.transferOwner", "Atomically transfer ownership", Identity.Success, true),
      validator("json", Identity.TransferOwner, validation),
      async (c) => c.json(await authentication().transferOwner(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/accounts",
      operation("orgAccounts.list", "List organization accounts", Identity.AccountPage),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await authentication().accounts(credentials(c), c.req.valid("query"))),
    )
    .patch(
      "/accounts/:accountID",
      operation("orgAccounts.update", "Update a member without removing the last owner", Identity.Account, true),
      validator("param", accountParam, validation),
      validator("json", Identity.AccountChange, validation),
      async (c) =>
        c.json(
          await authentication().updateAccount(credentials(c), c.req.valid("param").accountID, c.req.valid("json")),
        ),
    )
    .post(
      "/accounts/:accountID/reset",
      operation("orgAccounts.reset", "Create a one-time password reset link", Identity.TokenResult, true),
      validator("param", accountParam, validation),
      validator("json", Identity.ResetCreate, validation),
      async (c) =>
        c.json(
          await authentication().createReset(
            credentials(c),
            c.req.valid("param").accountID,
            c.req.valid("json").expectedRevision,
          ),
        ),
    )
    .post(
      "/auth/reset",
      operation("orgAuth.reset", "Consume a password reset link", Identity.Success, true),
      validator("json", Identity.ResetConsume, validation),
      async (c) => {
        checkOrigin(c)
        return c.json(await authentication().consumeReset(c.req.valid("json")))
      },
    )
    .post(
      "/projects",
      operation("orgProjects.create", "Create an organization project", Identity.ProjectView, true),
      validator("json", Identity.ProjectCreate, validation),
      async (c) => c.json(await Projects.create(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/projects",
      operation("orgProjects.list", "List projects visible to the current account", Identity.ProjectPage),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await Projects.list(credentials(c), c.req.valid("query"))),
    )
    .get(
      "/projects/:projectID",
      operation("orgProjects.get", "Read project access and lifecycle", Identity.ProjectView),
      validator("param", projectParam, validation),
      async (c) => c.json(await Projects.get(credentials(c), c.req.valid("param").projectID)),
    )
    .patch(
      "/projects/:projectID",
      operation("orgProjects.update", "Update, archive or restore a project", Identity.ProjectView, true),
      validator("param", projectParam, validation),
      validator("json", Identity.ProjectChange, validation),
      async (c) => c.json(await Projects.update(credentials(c), c.req.valid("param").projectID, c.req.valid("json"))),
    )
    .put(
      "/projects/:projectID/members/:accountID",
      operation("orgProjects.member", "Set or remove a project role", Identity.Success, true),
      validator("param", memberParam, validation),
      validator("json", Identity.ProjectMemberChange, validation),
      async (c) =>
        c.json(
          await Projects.member(
            credentials(c),
            c.req.valid("param").projectID,
            c.req.valid("param").accountID,
            c.req.valid("json"),
          ),
        ),
    )
}
