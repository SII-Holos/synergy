import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  OrganizationIdentity,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { createCredentials, readCredentials } from "./credentials"
import { MemberHomeError, readRecord, writeRecord } from "./record"

export const MemberIdentity = z.strictObject({
  orgID: OrganizationIdentity.ID,
  accountID: OrganizationIdentity.ID,
  deviceID: OrganizationIdentity.ID,
})
export type MemberIdentity = z.infer<typeof MemberIdentity>

const binding = { schemaVersion: z.literal(1), identity: MemberIdentity, origin: z.string() }
const Binding = z.discriminatedUnion("state", [
  z.strictObject({ ...binding, state: z.literal("provisioning") }),
  z.strictObject({ ...binding, state: z.literal("ready"), publicKey: Protocol.PublicKey }),
])
type Binding = z.infer<typeof Binding>

export interface MemberHome {
  home: string
  root: string
  identity: MemberIdentity
  origin: string
  publicKey: string
}

export function memberIdentityDigest(identity: MemberIdentity) {
  const value = MemberIdentity.parse(identity)
  return createHash("sha256")
    .update(JSON.stringify([value.orgID, value.accountID, value.deviceID]))
    .digest("hex")
}

function absolute(value: string) {
  if (!path.isAbsolute(value)) throw new MemberHomeError("Member Runtime Home must be absolute")
  return path.resolve(value)
}

function origin(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:" && url.origin === value) return value
  } catch {}
  throw new MemberHomeError(
    "Organization address must be an HTTPS origin without credentials, paths or query parameters",
  )
}

function filename(root: string) {
  return path.join(root, "organization.json")
}

async function entries(directory: string) {
  return fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

function withOwner<T>(home: string, identity: MemberIdentity, body: (root: string) => Promise<T>) {
  const root = path.join(home, ".synergy")
  const context = RuntimeContext.create({ home, root, env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME } })
  return context.run(async () => {
    try {
      for (const directory of [home, root]) {
        const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (stat?.isSymbolicLink()) throw new MemberHomeError("Member Runtime Home cannot be a symbolic link")
      }
      HomeOwnership.select({ owner: "organization-runtime", identity: memberIdentityDigest(identity) })
      return await body(root)
    } finally {
      context.dispose()
    }
  })
}

function checkIdentity(current: Binding, identity: MemberIdentity) {
  if (memberIdentityDigest(current.identity) !== memberIdentityDigest(identity))
    throw new MemberHomeError("Member Runtime identity does not match this Home")
  origin(current.origin)
}

async function ready(home: string, root: string, current: Binding): Promise<MemberHome> {
  if (current.state !== "ready") throw new MemberHomeError("Member Runtime provisioning is incomplete")
  const credentials = await readCredentials(root)
  if (!credentials || credentials.publicKey !== current.publicKey)
    throw new MemberHomeError("Member Runtime credentials are missing or do not match its identity")
  return { home, root, identity: current.identity, origin: current.origin, publicKey: current.publicKey }
}

export async function readMemberHome(input: string, expected: MemberIdentity) {
  const home = absolute(input)
  const identity = MemberIdentity.parse(expected)
  return withOwner(home, identity, async (root) => {
    await HomeOwnership.assert({ required: true })
    const current = await readRecord(filename(root), Binding, "identity records")
    if (!current) throw new MemberHomeError("Member Runtime identity is missing")
    checkIdentity(current, identity)
    return ready(home, root, current)
  })
}

export async function prepareMemberHome(input: { baseDirectory: string; identity: MemberIdentity; origin: string }) {
  const baseDirectory = absolute(input.baseDirectory)
  const identity = MemberIdentity.parse(input.identity)
  const address = origin(input.origin)
  const digest = memberIdentityDigest(identity)
  const home = path.join(baseDirectory, digest)
  return withFileLock({ directory: path.join(baseDirectory, ".locks"), key: digest }, () =>
    withOwner(home, identity, async (root) => {
      const owner = await HomeOwnership.assert()
      if (!owner) {
        if ((await entries(home)).length) throw new MemberHomeError("Member Runtime requires a new dedicated Home")
        await HomeOwnership.persist()
      }
      let current = await readRecord(filename(root), Binding, "identity records")
      if (!current) {
        if ((await entries(root)).some((entry) => !["home-ownership.json", "state"].includes(entry)))
          throw new MemberHomeError("Member Runtime identity is missing from an existing Home")
        current = { schemaVersion: 1, state: "provisioning", identity, origin: address }
        await writeRecord(filename(root), current)
      }
      checkIdentity(current, identity)
      if (current.origin !== address) throw new MemberHomeError("Organization address changed; update it explicitly")
      if (current.state === "ready") return ready(home, root, current)
      const credentials = (await readCredentials(root)) ?? (await createCredentials(root))
      const complete = { ...current, state: "ready" as const, publicKey: credentials.publicKey }
      await writeRecord(filename(root), complete)
      return ready(home, root, complete)
    }),
  )
}
