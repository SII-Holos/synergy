import { expect, test } from "bun:test"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationResourceProtocol as Resource,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { OrganizationAuthorityHistory } from "../src/authority-history"
import { OrganizationProjects } from "../src/projects"
import { OrganizationResources } from "../src/resources"
import { createAuthentication } from "../src/auth"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { directoryFixture } from "./support/session-directory"
import { fixture, password } from "./support/organization"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import path from "node:path"
import { registerHandoffAuthorityHistory } from "../src/handoff"
import { OrganizationKnowledge } from "../src/knowledge"
import { OrganizationArtifacts } from "../src/artifacts"
import { OrganizationCloud } from "../src/cloud"
import { OrganizationPublications } from "../src/publications"
import { OrganizationSessionDirectory } from "../src/session-directory"
import { OrganizationSharing } from "../src/sharing"
import { applySelection } from "./support/knowledge"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"

async function database<T>(home: string, body: (store: TransactionalStore) => Promise<T>) {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    return await body(store)
  } finally {
    await store.close()
  }
}

async function previousPrivateStartup(home: string) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `
    import { z } from "zod"
    import path from "node:path"
    import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
    import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
    const store = await TransactionalStore.open({ backend: "sqlite", namespace: "organization", filename: path.join(process.env.AUTHORITY_TEST_HOME, ".synergy", "data", "organization.sqlite") })
    try {
      const previous = Command.SigningIdentity.extend({ pkcs8: z.string().regex(/^(?:[a-f0-9]{2}){1,1024}$/) })
      previous.parse(await store.read(["organization", "signing-identity"]))
      process.stdout.write("ready")
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      process.stderr.write("UNSUPPORTED_PRIVATE_SIGNING_AUTHORITY")
      process.exitCode = 78
    } finally { await store.close() }
  `,
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, AUTHORITY_TEST_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

async function inspectHome(home: string) {
  const root = path.join(home, ".synergy")
  const context = RuntimeContext.create({ home, root, env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME } })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(root, "data", "organization.sqlite"),
  })
  context.storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
  try {
    return await context.run(async () => {
      OrganizationAuthorityHistory.register()
      registerHandoffAuthorityHistory()
      OrganizationKnowledge.registerAuthorityHistory()
      OrganizationArtifacts.registerAuthorityHistory()
      OrganizationCloud.registerAuthorityHistory()
      return { status: await AuthorityJournal.inspect(), history: await AuthorityJournal.entries({ limit: 128 }) }
    })
  } finally {
    await store.close()
    context.dispose()
  }
}

test("the real service establishes its baseline once and keeps validated one-time-link and password changes through restart", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const invite = (await (await owner.request("POST", "/invites", { role: "member" })).json()) as { token: string }
  const anonymous = f.client()
  const member = (await (
    await anonymous.request("POST", "/invites/consume", {
      token: invite.token,
      requestID: "journal-join",
      loginName: "joined",
      displayName: "Joined",
      password,
    })
  ).json()) as { accountID: string; revision: number }
  const joined = f.client()
  await joined.login("joined")
  expect(
    (await joined.request("POST", "/auth/password", { currentPassword: password, password: "new journal password" }))
      .status,
  ).toBe(200)
  expect(
    (
      await owner.request("PATCH", `/accounts/${member.accountID}`, {
        expectedRevision: member.revision + 1,
        state: "removed",
      })
    ).status,
  ).toBe(200)
  const home = f.service.home
  await f.service.close()
  const privateIdentity = await database(home, (store) => store.read(Keys.signingIdentity()))
  expect((privateIdentity as { schemaVersion: number }).schemaVersion).toBe(2)
  const previousPrivateReader = Command.SigningIdentity.extend({ pkcs8: z.string().regex(/^(?:[a-f0-9]{2}){1,1024}$/) })
  expect(previousPrivateReader.safeParse(privateIdentity).success).toBe(false)
  expect(await previousPrivateStartup(home)).toEqual({
    exit: 78,
    stdout: "",
    stderr: "UNSUPPORTED_PRIVATE_SIGNING_AUTHORITY",
  })
  const first = await inspectHome(home)
  expect(first.status.covered).toBe(true)
  expect(
    first.history.items.some((entry) => entry.operation === "organization.bootstrap" && entry.actor.kind === "system"),
  ).toBe(true)
  expect(
    first.history.items.some(
      (entry) =>
        entry.operation === "account.join" &&
        entry.actor.kind === "system" &&
        entry.actor.causedBy?.[0]?.kind === "account",
    ),
  ).toBe(true)
  expect(
    first.history.items.some(
      (entry) => entry.operation === "account.password" && entry.actor.subjectID === member.accountID,
    ),
  ).toBe(true)
  expect(JSON.stringify(first.history)).not.toContain(password)
  expect(JSON.stringify(first.history)).not.toContain(invite.token)
  await f.restart()
  await f.service.close()
  const second = await inspectHome(home)
  expect(second.status).toEqual(first.status)
  expect(second.history).toEqual(first.history)
})

test("an upgrade baselines retained authority once while a missing completed journal fails closed", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const account = (await (await owner.request("GET", "/auth/session")).json()) as { account: { accountID: string } }
  const home = f.service.home
  await f.service.close()
  const retained = await database(home, async (store) => {
    const original = await store.read(Keys.account(account.account.accountID))
    await store.transaction(async (tx) => {
      const [currentSigning] = await tx.readMany([Keys.signingIdentity()])
      const { historyContractHash: _history, ...originalSigning } = currentSigning as Record<string, unknown>
      await tx.write(Keys.signingIdentity(), { ...originalSigning, schemaVersion: 1 })
      await tx.removeTree(["storage_authority_journal"])
      const ledgerKey = StoragePath.metaMigrationLogDomain("organization")
      const [raw] = await tx.readMany([ledgerKey])
      const ledger = { ...(raw as Record<string, number>) }
      delete ledger["20261111-organization-authority-history"]
      await tx.write(ledgerKey, ledger)
    })
    return {
      account: original,
      signing: await store.read<{ keyID: string; publicKey: string; pkcs8: string }>(Keys.signingIdentity()),
    }
  })
  await database(home, (store) =>
    store.write(Keys.account(account.account.accountID), { unsupportedAuthorityVersion: 99 }),
  )
  await expect(f.restart()).rejects.toThrow()
  expect(
    (await database(home, (store) => store.read<{ schemaVersion: number }>(Keys.signingIdentity())))?.schemaVersion,
  ).toBe(1)
  await database(home, (store) => store.write(Keys.account(account.account.accountID), retained.account))
  await f.restart()
  await f.service.close()
  const upgraded = await inspectHome(home)
  expect(upgraded.status.covered).toBe(true)
  expect(upgraded.history.items).toEqual([])
  expect(await database(home, (store) => store.read(Keys.account(account.account.accountID)))).toEqual(retained.account)
  const upgradedSigning = await database(home, (store) =>
    store.read<{ keyID: string; publicKey: string; pkcs8: string }>(Keys.signingIdentity()),
  )
  expect(upgradedSigning?.keyID).toBe(retained.signing?.keyID)
  expect(upgradedSigning?.publicKey).toBe(retained.signing?.publicKey)
  expect(upgradedSigning?.pkcs8 === retained.signing?.pkcs8).toBe(true)
  await database(home, (store) => store.remove(["storage_authority_journal", "head"]))
  await expect(f.restart()).rejects.toThrow("not initialized")
})

test("canonical account, project and resource changes retain redacted authority evidence in their own commit", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    OrganizationAuthorityHistory.register()
    await Storage.write(Keys.info(), {
      schemaVersion: 1,
      orgID: "org",
      name: "Journal fixture",
      owners: ["owner"],
      revision: 1,
    })
    await OrganizationAuthorityHistory.initialize({
      orgID: "org",
      deploymentIncarnation: "deployment",
      schemaVersion: 1,
      createdAt: 1,
    })
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    const project = await OrganizationProjects.create(f.credentials.alice, { name: "Journal project", description: "" })
    await OrganizationProjects.member(f.credentials.alice, project.projectID, "bob", {
      expectedRevision: project.revision,
      role: "reader",
    })
    const resource = await OrganizationResources.create(
      f.credentials.admin,
      Resource.Create.parse({
        name: "Journal model",
        scope: { kind: "organization" },
        configuration: {
          protocol: "openai-compatible",
          endpoint: "https://models.example/v1",
          model: { id: "journal-model", name: "Journal model", limit: { context: 8192, output: 2048 } },
        },
        credential: { kind: "bearer", value: "journal-private-credential" },
      }),
    )
    await OrganizationResources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: project.projectID },
      { expectedRevision: 0, enabled: true },
    )
    await OrganizationResources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "project", id: project.projectID },
      { expectedRevision: 1, enabled: false },
    )
    const auth = await createAuthentication()
    await auth.updateAccount(f.credentials.owner, "bob", { expectedRevision: 1, state: "removed" })
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    const page = await AuthorityJournal.entries({ limit: 128 })
    expect(page.items.some((entry) => entry.operation === "resource.grant" && entry.actor.subjectID === "admin")).toBe(
      true,
    )
    expect(page.items.some((entry) => entry.operation === "account.update" && entry.actor.subjectID === "owner")).toBe(
      true,
    )
    expect(JSON.stringify(page)).not.toContain("journal-private-credential")
    expect(JSON.stringify(page)).not.toContain("unused fixture hash")
    const before = await AuthorityJournal.head()
    await expect(
      OrganizationProjects.member(f.credentials.reader, project.projectID, "bob", {
        expectedRevision: 2,
        role: "maintainer",
      }),
    ).rejects.toThrow()
    expect(await AuthorityJournal.head()).toEqual(before)
    await Storage.write(Keys.project(project.projectID), {
      ...(await Storage.read<Record<string, unknown>>(Keys.project(project.projectID))),
      state: "archived",
    })
    expect((await AuthorityJournal.inspect()).covered).toBe(false)
  })
})

test("published access, exact knowledge selections and Session visibility share their canonical authority transaction", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    OrganizationAuthorityHistory.register()
    OrganizationKnowledge.registerAuthorityHistory()
    OrganizationArtifacts.registerAuthorityHistory()
    await OrganizationAuthorityHistory.initialize({
      orgID: "org",
      deploymentIncarnation: "deployment",
      schemaVersion: 1,
      createdAt: 1,
    })
    await OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
      sessionID: "journal-source",
      projectID: "project",
      runtimeID: "runtime-alice",
    })
    const knowledge = await OrganizationPublications.create(f.credentials.alice, {
      requestID: "journal-material-upload",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    await OrganizationPublications.seal(f.credentials.alice, knowledge.uploadID, { fileCount: 0, totalBytes: 0 })
    const release = await OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "journal-material",
      itemID: "journal-material",
      expectedRevision: 0,
      uploadID: knowledge.uploadID,
      title: "Journal material",
      kind: "material",
    })
    await applySelection(f.credentials.bob, "project", {
      expectedRevision: 0,
      releases: [{ itemID: release.itemID, version: release.version, manifestHash: release.manifestHash }],
    })
    await OrganizationKnowledge.withdraw(f.credentials.alice, release.itemID, 1)
    const artifact = await OrganizationPublications.create(f.credentials.alice, {
      requestID: "journal-artifact-upload",
      purpose: "artifact",
      scope: { kind: "project", projectID: "project" },
      sourceSessionID: "journal-source",
    })
    await OrganizationPublications.seal(f.credentials.alice, artifact.uploadID, { fileCount: 0, totalBytes: 0 })
    await OrganizationArtifacts.publish(f.credentials.alice, {
      requestID: "journal-artifact",
      artifactID: "journal-artifact",
      expectedRevision: 0,
      uploadID: artifact.uploadID,
      title: "Journal artifact",
    })
    await OrganizationSharing.share(f.credentials.alice, "journal-source", { expectedShareGeneration: 0 })
    await OrganizationSharing.unshare(f.credentials.alice, "journal-source", { expectedShareGeneration: 1 })
    const inspection = await AuthorityJournal.inspect()
    expect(inspection.covered).toBe(true)
    const page = await AuthorityJournal.entries({ limit: 128 })
    for (const operation of [
      "session.reserve",
      "knowledge.publish",
      "knowledge.select",
      "knowledge.withdraw",
      "artifact.publish",
      "session.share",
      "session.unshare",
    ])
      expect(page.items.some((entry) => entry.operation === operation)).toBe(true)
  })
})
