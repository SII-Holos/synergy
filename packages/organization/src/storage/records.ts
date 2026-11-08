import { z } from "zod"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

export namespace OrganizationRecord {
  export const Info = Identity.Organization.extend({ schemaVersion: z.literal(1), owners: z.array(Identity.ID).min(1) })
  export const Account = Identity.Account.extend({ schemaVersion: z.literal(1), passwordHash: z.string().min(1) })
  export type Account = z.infer<typeof Account>
  export const LoginIndex = z.strictObject({ accountID: Identity.ID })
  const consumed = z.strictObject({ requestID: Identity.ID, fingerprint: Identity.Token, accountID: Identity.ID })
  const tokenState = z.strictObject({
    schemaVersion: z.literal(1),
    tokenHash: Identity.Token,
    expiresAt: z.number().int(),
  })
  export const Bootstrap = tokenState.extend({ consumed: consumed.extend({ result: Identity.Account }).optional() })
  export const Invite = Bootstrap.extend({
    createdBy: Identity.ID,
    issuerAuthRevision: Identity.Revision,
    role: z.enum(["admin", "member"]),
    revokedAt: z.number().int().optional(),
  })
  export const Reset = tokenState.extend({
    consumed: consumed.optional(),
    createdBy: Identity.ID,
    issuerAuthRevision: Identity.Revision,
    accountID: Identity.ID,
    authRevision: Identity.Revision,
  })
  export const Login = z.strictObject({
    schemaVersion: z.literal(1),
    tokenHash: Identity.Token,
    accountID: Identity.ID,
    authRevision: Identity.Revision,
    csrfHash: Identity.Token,
    expiresAt: z.number().int(),
    revokedAt: z.number().int().optional(),
  })
  export const Project = Identity.Project.extend({ schemaVersion: z.literal(1) })
  export const ProjectMember = z.strictObject({
    schemaVersion: z.literal(1),
    projectID: Identity.ID,
    accountID: Identity.ID,
    role: Identity.ProjectRole,
    revision: Identity.Revision,
  })

  export async function read<T>(schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
    const [value] = await Storage.readMany<unknown>([key])
    return value === undefined ? undefined : schema.parse(value)
  }

  export function publicAccount(account: Account): Identity.Account {
    const { schemaVersion: _, passwordHash: __, ...result } = account
    return Identity.Account.parse(result)
  }
}
