import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { prepareMemberHome } from "@ericsanchezok/synergy-organization-runtime/home"
import { readMemberRegistration } from "@ericsanchezok/synergy-organization-runtime/registration"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationDesktop as Desktop,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { DesktopServerManager, type DesktopServerManagerOptions } from "../server-manager.js"
import type { DesktopOrganizationAccounts } from "./accounts.js"
import { DesktopOrganizationError as Failure } from "./error.js"

const Device = z.strictObject({ version: z.literal(1), deviceID: z.uuid() })
type Access = Awaited<ReturnType<DesktopOrganizationAccounts["access"]>>
type Attempt = { controller: AbortController; users: Set<symbol>; result: Promise<Desktop.MemberRuntime> }
type Services = { close(): Promise<void> }
type Entry = {
  manager: DesktopServerManager
  runtimeID: string
  services?: Services
  servicesClosing?: Promise<void>
}
export type DesktopMemberConnection = {
  connectionID: string
  runtimeID: string
  browser: NonNullable<ReturnType<DesktopServerManager["browserConnection"]>>
}

export class DesktopMemberRuntimes {
  private entries = new Map<string, Entry>()
  private starts = new Map<string, Attempt>()
  private failed = new Set<string>()
  private closed = false
  private stopping: Promise<void> | undefined

  constructor(
    private options: {
      root: string
      accounts: DesktopOrganizationAccounts
      server: Pick<DesktopServerManagerOptions, "channel" | "resourcesPath">
      fetch?: typeof fetch
      ca?: string
      services?: (member: DesktopMemberConnection) => Services | Promise<Services>
    },
  ) {
    if (!path.isAbsolute(options.root)) throw new Failure("invalid_request")
  }

  async status(connectionID: string): Promise<Desktop.MemberRuntime> {
    if (!(await this.options.accounts.list()).some((connection) => connection.id === connectionID))
      throw new Failure("invalid_request")
    return this.snapshot(connectionID)
  }

  async start(connectionID: string, signal?: AbortSignal): Promise<Desktop.MemberRuntime> {
    this.check(signal)
    const access = await this.options.accounts.access(connectionID)
    this.check(signal)
    let attempt = this.starts.get(connectionID)
    if (attempt?.controller.signal.aborted) {
      await attempt.result.catch(() => {})
      this.check(signal)
      attempt = this.starts.get(connectionID)
    }
    if (!attempt) {
      const controller = new AbortController()
      this.failed.delete(connectionID)
      const result = this.launch(access, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.failed.add(connectionID)
          throw error
        })
        .finally(() => {
          if (this.starts.get(connectionID)?.result === result) this.starts.delete(connectionID)
        })
      attempt = { controller, users: new Set(), result }
      this.starts.set(connectionID, attempt)
    }
    const user = Symbol()
    attempt.users.add(user)
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Failure("cancelled"))
    })
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    try {
      return await Promise.race([attempt.result, cancelled])
    } finally {
      signal?.removeEventListener("abort", cancel)
      attempt.users.delete(user)
      if (!attempt.users.size) attempt.controller.abort()
    }
  }

  running() {
    return [...this.entries].flatMap(([connectionID, entry]) => {
      const connection = entry.manager.connection()
      return connection ? [{ connectionID, runtimeID: entry.runtimeID, connection }] : []
    })
  }

  stopAll(): Promise<void> {
    if (this.stopping) return this.stopping
    for (const attempt of this.starts.values()) attempt.controller.abort()
    this.stopping = (async () => {
      await Promise.allSettled([...this.starts.values()].map((attempt) => attempt.result))
      const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.stopEntry(entry)))
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Member Runtime shutdown failed")
    })().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }

  close() {
    this.closed = true
    return this.stopAll()
  }

  [Symbol.asyncDispose]() {
    return this.close()
  }

  private check(signal?: AbortSignal) {
    if (this.closed || this.stopping || signal?.aborted) throw new Failure("cancelled")
  }

  private async stopEntry(entry: Entry, stopping?: Promise<void>) {
    const results = await Promise.allSettled([this.closeServices(entry), stopping ?? entry.manager.stop()])
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Member Runtime services did not stop cleanly")
  }

  private closeServices(entry: Entry): Promise<void> {
    if (entry.servicesClosing) return entry.servicesClosing
    const services = entry.services
    if (!services) return Promise.resolve()
    return (entry.servicesClosing = Promise.resolve()
      .then(() => services.close())
      .then(() => {
        if (entry.services === services) entry.services = undefined
      }))
  }

  private snapshot(connectionID: string): Desktop.MemberRuntime {
    const entry = this.entries.get(connectionID)
    const state = entry?.manager.status().state
    return {
      connectionID,
      runtimeID: entry?.runtimeID,
      state: this.starts.has(connectionID)
        ? "starting"
        : this.failed.has(connectionID) || state === "failed"
          ? "failed"
          : state === "running"
            ? "running"
            : "stopped",
    }
  }

  private async launch(access: Access, signal: AbortSignal): Promise<Desktop.MemberRuntime> {
    const { connection } = access
    const id = connection.id
    const previous = this.entries.get(id)
    if (previous?.manager.connection()) return { connectionID: id, runtimeID: previous.runtimeID, state: "running" }
    if (previous) await this.stopEntry(previous)
    this.check(signal)
    const deviceID = await this.device(signal)
    this.check(signal)
    const member = await prepareMemberHome({
      baseDirectory: path.join(this.options.root, "homes"),
      identity: { orgID: connection.orgID, accountID: connection.account.accountID, deviceID },
      origin: connection.issuer,
    })
    this.check(signal)
    const registration = await readMemberRegistration(member.home, member.identity)
    this.check(signal)
    if (
      registration &&
      (registration.deploymentIncarnation !== connection.deploymentIncarnation || registration.state !== "active")
    )
      throw new Failure("identity_changed")
    const ticket = registration ? undefined : await this.ticket(access, member, signal)
    this.check(signal)
    const runtimeID = (registration ?? ticket!.runtime).runtimeID
    const manager = new DesktopServerManager({
      ...this.options.server,
      mode: "managed",
      userDataPath: path.join(member.root, "state", "desktop"),
      logDir: path.join(member.root, "log", "desktop"),
      onExit: () => {
        void this.closeServices(entry).catch(() => console.error("Member Runtime service cleanup failed after exit."))
      },
      member: {
        home: member.home,
        identity: member.identity,
        deploymentIncarnation: connection.deploymentIncarnation,
        ticket,
        ca: this.options.ca,
      },
    })
    const entry: Entry = { manager, runtimeID }
    this.entries.set(id, entry)
    let stopping: Promise<void> | undefined
    const cancel = () => {
      stopping ??= manager.stop()
      void stopping.catch(() => {})
    }
    signal.addEventListener("abort", cancel, { once: true })
    try {
      this.check(signal)
      await manager.start()
      this.check(signal)
      if (this.options.services) {
        const browser = manager.browserConnection()
        if (!browser) throw new Failure("unavailable")
        entry.services = await this.options.services({ connectionID: id, runtimeID, browser })
        this.check(signal)
      }
      if (!manager.connection()) throw new Failure("unavailable")
      return { connectionID: id, runtimeID, state: "running" }
    } catch (error) {
      try {
        await this.stopEntry(entry, stopping)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Member Runtime startup cleanup failed")
      }
      throw error
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }

  private async ticket(access: Access, member: Awaited<ReturnType<typeof prepareMemberHome>>, signal: AbortSignal) {
    const client = createOrganizationClient({
      baseUrl: access.connection.issuer,
      fetch: this.options.fetch,
      headers: { authorization: `Bearer ${access.accessToken}` },
      credentials: "omit",
      redirect: "error",
    })
    const result = await client.orgRuntime.registerMember(
      { orgMemberRuntimeRegistration: { deviceID: member.identity.deviceID, publicKey: member.publicKey } },
      { signal },
    )
    const ticket = Protocol.Ticket.safeParse(result.data)
    if (!ticket.success) throw new Failure(result.response.status === 401 ? "reauthorization_required" : "unavailable")
    const runtime = ticket.data.runtime
    if (
      runtime.runtimeKind !== "member" ||
      runtime.orgID !== member.identity.orgID ||
      runtime.deploymentIncarnation !== access.connection.deploymentIncarnation ||
      runtime.accountID !== member.identity.accountID ||
      runtime.deviceID !== member.identity.deviceID ||
      runtime.publicKey !== member.publicKey ||
      runtime.state === "revoked"
    )
      throw new Failure("identity_changed")
    return ticket.data
  }

  private device(signal: AbortSignal) {
    return withFileLock({ directory: path.join(this.options.root, ".locks"), key: "device", signal }, async () => {
      const filename = path.join(this.options.root, "device.json")
      let file
      try {
        file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Failure("storage_unavailable")
      }
      if (file) {
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.size > 1024) throw new Failure("storage_unavailable")
          return Device.parse(JSON.parse(await file.readFile("utf8"))).deviceID
        } finally {
          await file.close()
        }
      }
      const homes = await fs.readdir(path.join(this.options.root, "homes")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (homes.some((name) => name !== ".locks")) throw new Failure("identity_changed")
      const device = Device.parse({ version: 1, deviceID: randomUUID() })
      this.check(signal)
      await AtomicFile.writeJsonAtomic(filename, JSON.stringify(device) + "\n", { private: true, durable: true })
      return device.deviceID
    })
  }
}
