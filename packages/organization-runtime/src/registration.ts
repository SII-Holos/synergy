import path from "node:path"
import { z } from "zod"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { readMemberHome, type MemberHome, type MemberIdentity } from "./home.js"
import { MemberHomeError, readRecord } from "./record.js"

const Enrollment = z.strictObject({ schemaVersion: z.literal(1), registration: Protocol.Registration })

export function registrationFilename(root: string) {
  return path.join(root, "organization-registration.json")
}

export function checkMemberRegistration(member: MemberHome, registration: Protocol.Registration) {
  if (
    registration.orgID !== member.identity.orgID ||
    registration.accountID !== member.identity.accountID ||
    registration.deviceID !== member.identity.deviceID ||
    registration.publicKey !== member.publicKey
  )
    throw new MemberHomeError("Runtime registration does not match this Home identity")
}

export async function readMemberRegistration(home: string, identity: MemberIdentity) {
  const member = await readMemberHome(home, identity)
  const stored = await readRecord(registrationFilename(member.root), Enrollment, "registration records")
  if (!stored) return
  checkMemberRegistration(member, stored.registration)
  return stored.registration
}
