import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { digest, token } from "../../src/auth/secret"
import { organizationApp } from "../../src/http"
import { cookie } from "../../src/routes/shared"
import { registerOrganizationMigrations } from "../../src/migration"

export async function directoryFixture() {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-directory-"))
  const ids = ["owner", "admin", "alice", "bob", "reader", "outsider", "foreign"] as const
  const credentials = Object.fromEntries(ids.map((id) => [id, { token: token() }]))
  async function open() {
    const context = RuntimeContext.create({
      home,
      root: path.join(home, ".synergy"),
      env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
    })
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "organization",
      filename: path.join(home, "directory.sqlite"),
    })
    context.storage = { store, artifactDirectory: path.join(home, "artifacts") }
    context.run(registerOrganizationMigrations)
    return { context, store }
  }
  let current = await open()
  const app = organizationApp(() => true, undefined, "https://organization.example")
  const run = <T>(body: () => T | Promise<T>) => current.context.run(body)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => run(() => app.fetch(request)) })
  async function closeStore() {
    await run(async () => {
      ObservabilityMetrics.stop()
      await ObservabilityStore.stop()
      await current.store.close()
    })
    current.context.dispose()
  }
  await run(() =>
    Storage.transaction(async () => {
      for (const id of ids) {
        const orgID = id === "foreign" ? "other-org" : "org"
        await Storage.write(
          Keys.account(id),
          Record.Account.parse({
            schemaVersion: 1,
            accountID: id,
            orgID,
            loginName: id,
            displayName: id,
            passwordHash: "unused fixture hash",
            role: id === "owner" || id === "admin" ? id : "member",
            state: "active",
            revision: 1,
            authRevision: 1,
            createdAt: 1,
          }),
        )
        await Storage.write(
          Keys.login(digest(credentials[id].token)),
          Record.Login.parse({
            schemaVersion: 1,
            tokenHash: digest(credentials[id].token),
            csrfHash: digest("f".repeat(64)),
            accountID: id,
            authRevision: 1,
            expiresAt: Date.now() + 60_000,
          }),
        )
        await Storage.write(
          Keys.runtime(`runtime-${id}`),
          Record.RuntimeRegistration.parse({
            schemaVersion: 1,
            runtimeID: `runtime-${id}`,
            orgID,
            deploymentIncarnation: "deployment",
            runtimeKind: "member",
            accountID: id,
            deviceID: `device-${id}`,
            publicKey: "a".repeat(64),
            state: "active",
            revision: 1,
            connectionEpoch: 1,
            createdAt: 1,
          }),
        )
      }
      await Storage.write(
        Keys.project("project"),
        Record.Project.parse({
          schemaVersion: 1,
          projectID: "project",
          orgID: "org",
          name: "Project",
          description: "",
          state: "active",
          revision: 1,
          createdAt: 1,
        }),
      )
      for (const [accountID, role] of [
        ["alice", "maintainer"],
        ["bob", "collaborator"],
        ["reader", "reader"],
      ]) {
        const value = Record.ProjectMember.parse({
          schemaVersion: 1,
          accountID,
          projectID: "project",
          role,
          revision: 1,
        })
        await Storage.write(Keys.projectMember("project", accountID), value)
        await Storage.write(Keys.projectAccess(accountID, "project"), value)
      }
    }),
  )
  return {
    credentials,
    run,
    baseUrl: server.url.toString(),
    headers(id: string) {
      return { cookie: `${cookie}=${credentials[id].token}` }
    },
    async request(id: string, route: string) {
      return fetch(new URL(`/org/v1${route}`, server.url), { headers: this.headers(id) })
    },
    async restart() {
      await closeStore()
      current = await open()
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await closeStore()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}
