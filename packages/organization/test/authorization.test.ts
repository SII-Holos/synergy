import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { authorize } from "../src/authorization"
import { digest, token } from "../src/auth/secret"
import { OrganizationProjects } from "../src/projects"

async function fixture() {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-authorization-"))
  const context = RuntimeContext.create({
    home,
    root: path.join(home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
  })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(home, "authorization.sqlite"),
  })
  context.storage = { store, artifactDirectory: path.join(home, "artifacts") }
  const credentials = Object.fromEntries(["owner", "admin", "member", "foreign"].map((id) => [id, { token: token() }]))
  await context.run(() =>
    Storage.transaction(async () => {
      await Storage.write(Keys.deployment(), {
        schemaVersion: 1,
        orgID: "org",
        deploymentIncarnation: "deployment",
        createdAt: 1,
      })
      for (const [id, credential] of Object.entries(credentials)) {
        await Storage.write(
          Keys.account(id),
          Record.Account.parse({
            schemaVersion: 1,
            orgID: id === "foreign" ? "other-org" : "org",
            accountID: id,
            loginName: id,
            displayName: id,
            passwordHash: "unused fixture hash",
            role: id === "owner" || id === "admin" ? id : "member",
            state: "active",
            revision: 1,
            authRevision: 1,
            createdAt: Date.now(),
          }),
        )
        await Storage.write(
          Keys.login(digest(credential.token)),
          Record.Login.parse({
            schemaVersion: 2,
            orgID: id === "foreign" ? "other-org" : "org",
            deploymentIncarnation: "deployment",
            tokenHash: digest(credential.token),
            csrfHash: digest("fixture-csrf"),
            accountID: id,
            authRevision: 1,
            expiresAt: Date.now() + 60_000,
          }),
        )
      }
    }),
  )
  return {
    credentials,
    run: <T>(body: () => Promise<T>) => context.run(body),
    async [Symbol.asyncDispose]() {
      await context.run(async () => {
        ObservabilityMetrics.stop()
        await ObservabilityStore.stop()
        await store.close()
      })
      context.dispose()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test("one authorization entry resolves account ownership, owner-only actions and unknown actions", async () => {
  await using f = await fixture()
  await f.run(() =>
    Storage.snapshot(async () => {
      const { owner, admin, member } = f.credentials
      expect((await authorize(member, "organization.read")).account.accountID).toBe("member")
      expect((await authorize(member, "project.create")).account.accountID).toBe("member")
      expect((await authorize(member, "account.profile", { accountID: "member" })).target.accountID).toBe("member")
      expect((await authorize(admin, "account.manage", { accountID: "member" })).target.accountID).toBe("member")
      expect((await authorize(owner, "account.promote-owner", { accountID: "admin" })).target.accountID).toBe("admin")
      for (const action of ["account.manage", "account.reset", "account.promote-owner", "account.transfer-owner"])
        await expect(authorize(admin, action, { accountID: "owner" })).rejects.toMatchObject({
          data: { code: "PERMISSION_DENIED" },
        })
      await expect(authorize(member, "accounts.list")).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
      await expect(authorize(member, "account.profile", { accountID: "owner" })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
      await expect(authorize(owner, "account.manage", { accountID: "foreign" })).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
      await expect(authorize(owner, "account.manage", { accountID: "missing" })).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
      await expect(authorize(owner, "unknown.action")).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
      await expect(authorize(owner, "unknown.action", { accountID: "member" })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
    }),
  )
})

test("authorization rechecks durable revocation and never grants project execution from an organization role", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await Storage.transaction(async () => {
      await Storage.write(
        Keys.project("project"),
        Record.Project.parse({
          schemaVersion: 1,
          orgID: "org",
          projectID: "project",
          name: "Project",
          description: "",
          state: "active",
          revision: 1,
          createdAt: Date.now(),
        }),
      )
    })
    await Storage.snapshot(async () => {
      expect(
        (await authorize(f.credentials.admin, "project.read", { projectID: "project" })).view.permissions.execute,
      ).toBe(false)
      await expect(authorize(f.credentials.owner, "project.execute", { projectID: "project" })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
      await expect(authorize(f.credentials.owner, "unknown.action", { projectID: "project" })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
    })
    await expect(
      OrganizationProjects.member(f.credentials.owner, "project", "foreign", {
        expectedRevision: 1,
        role: "collaborator",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await Storage.transaction(async () => {
      const account = await Storage.read<Record.Account>(Keys.account("admin"))
      await Storage.write(Keys.account("admin"), { ...account, authRevision: account.authRevision + 1, role: "member" })
    })
    for (const action of ["organization.read", "invites.create", "accounts.list", "project.create"])
      await expect(Storage.snapshot(() => authorize(f.credentials.admin, action))).rejects.toMatchObject({
        data: { code: "AUTHENTICATION_REQUIRED" },
      })
  })
})
