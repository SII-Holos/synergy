import { z } from "zod"

export namespace OrganizationIdentity {
  export const ID = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
  export const Revision = z.number().int().nonnegative()
  export const Name = z.string().trim().min(1).max(200)
  export const Role = z.enum(["owner", "admin", "member"])
  export const ProjectRole = z.enum(["maintainer", "collaborator", "reader"])
  export const Password = z.string().min(12).max(1024)
  export const LoginName = z
    .string()
    .max(320)
    .transform((value) => value.normalize("NFKC").trim().toLowerCase())
    .pipe(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9][a-z0-9._@+-]*$/),
    )
  export const Token = z.string().regex(/^[a-f0-9]{64}$/)
  export const Account = z
    .strictObject({
      accountID: ID,
      orgID: ID,
      loginName: LoginName,
      displayName: Name,
      role: Role,
      state: z.enum(["active", "removed"]),
      revision: Revision,
      authRevision: Revision,
      createdAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgAccount" })
  export type Account = z.infer<typeof Account>
  export const Organization = z
    .strictObject({
      orgID: ID,
      name: Name,
      revision: Revision,
    })
    .meta({ ref: "OrgOrganization" })
  export const Bootstrap = z
    .strictObject({
      token: Token,
      requestID: ID,
      organizationName: Name,
      loginName: LoginName,
      displayName: Name,
      password: Password,
    })
    .meta({ ref: "OrgBootstrapInput" })
  export type Bootstrap = z.infer<typeof Bootstrap>
  export const Login = z
    .strictObject({ loginName: LoginName, password: z.string().max(1024) })
    .meta({ ref: "OrgLoginInput" })
  export type Login = z.infer<typeof Login>
  export const LoginResult = z
    .strictObject({ account: Account, csrfToken: Token, expiresAt: z.number().int() })
    .meta({ ref: "OrgLoginResult" })
  export const CurrentSession = z
    .strictObject({ account: Account, csrfToken: Token, expiresAt: z.number().int() })
    .meta({ ref: "OrgCurrentSession" })
  export const Success = z.strictObject({ ok: z.literal(true) }).meta({ ref: "OrgSuccess" })
  export const Empty = z.strictObject({}).meta({ ref: "OrgEmptyInput" })
  export const PasswordChange = z
    .strictObject({ currentPassword: z.string().max(1024), password: Password })
    .meta({ ref: "OrgPasswordChange" })
  export type PasswordChange = z.infer<typeof PasswordChange>
  export const InviteCreate = z.strictObject({ role: z.enum(["admin", "member"]) }).meta({ ref: "OrgInviteCreate" })
  export type InviteCreate = z.infer<typeof InviteCreate>
  export const TokenResult = z
    .strictObject({ token: Token, expiresAt: z.number().int() })
    .meta({ ref: "OrgTokenResult" })
  export const InviteConsume = z
    .strictObject({ token: Token, requestID: ID, loginName: LoginName, displayName: Name, password: Password })
    .meta({ ref: "OrgInviteConsume" })
  export type InviteConsume = z.infer<typeof InviteConsume>
  export const AccountChange = z
    .strictObject({
      expectedRevision: Revision,
      role: Role.optional(),
      state: z.literal("removed").optional(),
      displayName: Name.optional(),
    })
    .refine(
      (value) => value.role !== undefined || value.state !== undefined || value.displayName !== undefined,
      "No change supplied",
    )
    .meta({ ref: "OrgAccountChange" })
  export type AccountChange = z.infer<typeof AccountChange>
  export const TransferOwner = z
    .strictObject({ accountID: ID, expectedRevision: Revision, targetRevision: Revision })
    .meta({ ref: "OrgTransferOwner" })
  export type TransferOwner = z.infer<typeof TransferOwner>
  export const ResetCreate = z.strictObject({ expectedRevision: Revision }).meta({ ref: "OrgResetCreate" })
  export const ResetConsume = z
    .strictObject({ token: Token, requestID: ID, password: Password })
    .meta({ ref: "OrgResetConsume" })
  export type ResetConsume = z.infer<typeof ResetConsume>
  export const Page = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: ID.optional(),
  })
  export type Page = z.infer<typeof Page>
  export const AccountPage = z
    .strictObject({ items: z.array(Account), cursor: ID.optional() })
    .meta({ ref: "OrgAccountPage" })
  export const Project = z
    .strictObject({
      projectID: ID,
      orgID: ID,
      name: Name,
      description: z.string().max(4000),
      state: z.enum(["active", "archived"]),
      revision: Revision,
      createdAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgProject" })
  export type Project = z.infer<typeof Project>
  export const ProjectView = Project.extend({
    permissions: z.strictObject({ read: z.boolean(), manage: z.boolean(), execute: z.boolean() }),
    role: ProjectRole.optional(),
  }).meta({ ref: "OrgProjectView" })
  export type ProjectView = z.infer<typeof ProjectView>
  export const ProjectPage = z
    .strictObject({ items: z.array(ProjectView), cursor: ID.optional() })
    .meta({ ref: "OrgProjectPage" })
  export const ProjectCreate = z
    .strictObject({ name: Name, description: z.string().max(4000).default("") })
    .meta({ ref: "OrgProjectCreate" })
  export type ProjectCreate = z.infer<typeof ProjectCreate>
  export const ProjectChange = z
    .strictObject({
      expectedRevision: Revision,
      name: Name.optional(),
      description: z.string().max(4000).optional(),
      state: z.enum(["active", "archived"]).optional(),
    })
    .refine(
      (value) => value.name !== undefined || value.description !== undefined || value.state !== undefined,
      "No change supplied",
    )
    .meta({ ref: "OrgProjectChange" })
  export type ProjectChange = z.infer<typeof ProjectChange>
  export const ProjectMemberChange = z
    .strictObject({ expectedRevision: Revision, role: ProjectRole.nullable() })
    .meta({ ref: "OrgProjectMemberChange" })
  export type ProjectMemberChange = z.infer<typeof ProjectMemberChange>
}
