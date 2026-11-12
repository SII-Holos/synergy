import path from "node:path"
import { z } from "zod"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import {
  readRuntimeHome,
  type RuntimeHome,
  type RuntimeIdentity,
  type MemberHome,
  type MemberIdentity,
} from "./home.js"
import { MemberHomeError, readRecordSnapshot, parseRecord } from "./record.js"

const Enrollment = z.strictObject({ schemaVersion: z.literal(1), registration: Protocol.Registration })

export function registrationFilename(root: string) {
  return path.join(root, "organization-registration.json")
}

export function checkMemberRegistration(
  member: MemberHome,
  registration: Protocol.Registration,
): asserts registration is Protocol.MemberRegistrationRecord {
  checkRuntimeRegistration(member, registration)
  if (registration.runtimeKind !== "member") throw new MemberHomeError("Runtime registration is not a member identity")
}

export function checkRuntimeRegistration(member: RuntimeHome, registration: Protocol.Registration) {
  if (
    registration.orgID !== member.identity.orgID ||
    ("accountID" in member.identity
      ? registration.runtimeKind !== "member" ||
        registration.accountID !== member.identity.accountID ||
        registration.deviceID !== member.identity.deviceID
      : registration.runtimeKind !== "hosted") ||
    registration.publicKey !== member.publicKey
  )
    throw new MemberHomeError("Runtime registration does not match this Home identity")
}

export async function readMemberRegistration(home: string, identity: MemberIdentity) {
  const stored = await readRuntimeRegistration(home, identity)
  return stored ? Protocol.MemberRegistrationRecord.parse(stored) : undefined
}

export async function readRuntimeRegistration(home: string, identity: RuntimeIdentity) {
  const member = await readRuntimeHome(home, identity)
  return (await captureRegistrationRecord(member))?.value.registration
}

export function verifyRegistrationRecord(bytes: Uint8Array, member: RuntimeHome) {
  const stored = parseRecord(bytes, Enrollment, "registration records")
  checkRuntimeRegistration(member, stored.registration)
  return stored.registration
}

export async function captureRegistrationRecord(member: RuntimeHome, options: { signal?: AbortSignal } = {}) {
  const stored = await readRecordSnapshot(
    registrationFilename(member.root),
    Enrollment,
    "registration records",
    options,
  )
  if (!stored) return
  checkRuntimeRegistration(member, stored.value.registration)
  return stored
}
