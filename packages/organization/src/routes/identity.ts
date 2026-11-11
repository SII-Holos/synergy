import { Hono } from "hono"
import { setCookie, deleteCookie } from "hono/cookie"
import { validator } from "hono-openapi"
import { z } from "zod"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import type { Authentication } from "../auth"
import { OrganizationProjects as Projects } from "../projects"
import { cookie, cookieOptions, operation, validation, browserCredentials } from "./shared"

const accountParam = z.strictObject({ accountID: Identity.ID })
const inviteParam = z.strictObject({ inviteID: Identity.ID })
const projectParam = z.strictObject({ projectID: Identity.ID })
const memberParam = projectParam.extend({ accountID: Identity.ID })

export function identityRoutes(authentication: () => Authentication, publicOrigin?: string) {
  const { checkOrigin, credentials } = browserCredentials(publicOrigin)
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
      "/invites",
      operation(
        "orgInvites.list",
        "List safe invitation metadata for current administrators or issuers",
        Identity.InvitePage,
      ),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await authentication().invites(credentials(c), c.req.valid("query"))),
    )
    .post(
      "/invites/:inviteID/revoke",
      operation(
        "orgInvites.revoke",
        "Revoke an unconsumed invitation with its current revision",
        Identity.Invite,
        true,
      ),
      validator("param", inviteParam, validation),
      validator("json", Identity.InviteRevoke, validation),
      async (c) =>
        c.json(
          await authentication().revokeInvite(
            credentials(c),
            c.req.valid("param").inviteID,
            c.req.valid("json").expectedRevision,
          ),
        ),
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
    .post(
      "/organization/leave",
      operation(
        "orgOrganization.leave",
        "Leave the organization as the current account, retaining its last owner",
        Identity.Success,
        true,
      ),
      validator("json", Identity.Leave, validation),
      async (c) => {
        const result = await authentication().leave(credentials(c), c.req.valid("json").expectedRevision)
        deleteCookie(c, cookie, cookieOptions)
        return c.json(result)
      },
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
    .get(
      "/projects/:projectID/members",
      operation("orgProjects.members", "List public project member identities", Identity.ProjectMemberPage),
      validator("param", projectParam, validation),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await Projects.members(credentials(c), c.req.valid("param").projectID, c.req.valid("query"))),
    )
    .get(
      "/projects/:projectID/member-candidates",
      operation(
        "orgProjects.candidates",
        "Find current accounts for project membership management",
        Identity.ProjectCandidatePage,
      ),
      validator("param", projectParam, validation),
      validator("query", Identity.CandidateQuery, validation),
      async (c) =>
        c.json(await Projects.candidates(credentials(c), c.req.valid("param").projectID, c.req.valid("query"))),
    )
}
