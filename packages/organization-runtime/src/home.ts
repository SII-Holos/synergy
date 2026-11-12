import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { createCredentials, readCredentials } from "./credentials.js"
import { MemberHomeError, readRecord, writeRecord } from "./record.js"
import {
  Binding,
  MemberBinding,
  HostedBinding,
  NativeHomeReaderContract,
  MemberIdentity,
  HostedIdentity,
  RuntimeIdentity,
} from "./home-schema.js"
export { MemberIdentity, HostedIdentity, RuntimeIdentity, NativeHomeReaderContract } from "./home-schema.js"

export interface RuntimeHome {
  home: string
  root: string
  identity: RuntimeIdentity
  origin: string
  publicKey: string
}
export interface MemberHome extends RuntimeHome {
  identity: MemberIdentity
}
export interface HostedHome extends RuntimeHome {
  identity: HostedIdentity
}

export function memberIdentityDigest(identity: MemberIdentity) {
  return runtimeIdentityDigest(MemberIdentity.parse(identity))
}

export function runtimeIdentityDigest(identity: RuntimeIdentity) {
  const value = RuntimeIdentity.parse(identity)
  return createHash("sha256")
    .update(
      JSON.stringify(
        "accountID" in value ? [value.orgID, value.accountID, value.deviceID] : ["hosted", value.orgID, value.hostID],
      ),
    )
    .digest("hex")
}

function absolute(value: string) {
  if (!path.isAbsolute(value)) throw new MemberHomeError("Member Runtime Home must be absolute")
  return path.resolve(value)
}

export function runtimeHomeOrigin(value: string) {
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

async function withOwner<T>(
  home: string,
  identity: RuntimeIdentity,
  body: (root: string, owner: ReturnType<typeof HomeOwnershipFile.open>) => Promise<T>,
) {
  const root = path.join(home, ".synergy")
  const owner = HomeOwnershipFile.open({
    root,
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
    selected: {
      schemaVersion: 2,
      owner: "organization-runtime",
      identity: runtimeIdentityDigest(identity),
      readerContract: NativeHomeReaderContract,
    },
  })
  for (const directory of [home, root]) {
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat?.isSymbolicLink()) throw new MemberHomeError("Member Runtime Home cannot be a symbolic link")
  }
  return body(root, owner)
}

function checkIdentity(current: Binding, identity: RuntimeIdentity) {
  if (runtimeIdentityDigest(current.identity) !== runtimeIdentityDigest(identity))
    throw new MemberHomeError("Member Runtime identity does not match this Home")
  runtimeHomeOrigin(current.origin)
}

async function ready(home: string, root: string, current: Binding): Promise<RuntimeHome> {
  if (current.state !== "ready") throw new MemberHomeError("Member Runtime provisioning is incomplete")
  const credentials = await readCredentials(root)
  if (!credentials || credentials.publicKey !== current.publicKey)
    throw new MemberHomeError("Member Runtime credentials are missing or do not match its identity")
  return { home, root, identity: current.identity, origin: current.origin, publicKey: current.publicKey }
}

export async function readRuntimeHome(input: string, expected: RuntimeIdentity) {
  const home = absolute(input)
  const identity = RuntimeIdentity.parse(expected)
  return withOwner(home, identity, async (root, owner) => {
    await owner.assert({ required: true })
    const current = await readRecord(filename(root), Binding, "identity records")
    if (!current) throw new MemberHomeError("Member Runtime identity is missing")
    checkIdentity(current, identity)
    return ready(home, root, current)
  })
}

async function prepareRuntimeHome(input: { baseDirectory: string; identity: RuntimeIdentity; origin: string }) {
  const baseDirectory = absolute(input.baseDirectory)
  const identity = RuntimeIdentity.parse(input.identity)
  const address = runtimeHomeOrigin(input.origin)
  const digest = runtimeIdentityDigest(identity)
  const home = path.join(baseDirectory, digest)
  return withOwner(home, identity, (root, ownership) =>
    withFileLock({ directory: path.join(baseDirectory, ".locks"), key: digest }, async () => {
      const owner = await ownership.assert()
      if (!owner) {
        if ((await entries(home)).length) throw new MemberHomeError("Member Runtime requires a new dedicated Home")
        await ownership.persist()
      }
      let current = await readRecord(filename(root), Binding, "identity records")
      if (!current) {
        if ((await entries(root)).some((entry) => !["home-ownership.json", "state"].includes(entry)))
          throw new MemberHomeError("Member Runtime identity is missing from an existing Home")
        current =
          "accountID" in identity
            ? MemberBinding.parse({
                schemaVersion: 2,
                state: "provisioning",
                identity,
                origin: address,
                readerContract: NativeHomeReaderContract,
              })
            : HostedBinding.parse({
                schemaVersion: 2,
                state: "provisioning",
                identity,
                origin: address,
                readerContract: NativeHomeReaderContract,
              })
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

export async function readMemberHome(input: string, expected: MemberIdentity): Promise<MemberHome> {
  const home = await readRuntimeHome(input, MemberIdentity.parse(expected))
  return { ...home, identity: MemberIdentity.parse(home.identity) }
}

export async function readHostedHome(input: string, expected: HostedIdentity): Promise<HostedHome> {
  const home = await readRuntimeHome(input, HostedIdentity.parse(expected))
  return { ...home, identity: HostedIdentity.parse(home.identity) }
}

export async function prepareMemberHome(input: {
  baseDirectory: string
  identity: MemberIdentity
  origin: string
}): Promise<MemberHome> {
  const home = await prepareRuntimeHome({ ...input, identity: MemberIdentity.parse(input.identity) })
  return { ...home, identity: MemberIdentity.parse(home.identity) }
}

export async function prepareHostedHome(input: {
  baseDirectory: string
  identity: HostedIdentity
  origin: string
}): Promise<HostedHome> {
  const home = await prepareRuntimeHome({ ...input, identity: HostedIdentity.parse(input.identity) })
  return { ...home, identity: HostedIdentity.parse(home.identity) }
}
