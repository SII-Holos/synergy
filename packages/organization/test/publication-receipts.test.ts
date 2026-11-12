import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationKnowledge } from "../src/knowledge"
import { OrganizationArtifacts } from "../src/artifacts"
import { OrganizationPublications } from "../src/publications"
import { OrganizationProjects } from "../src/projects"
import { OrganizationSessionDirectory } from "../src/session-directory"
import { OrganizationStoragePath } from "../src/storage/path"
import { directoryFixture } from "./support/session-directory"
import { organizationOpenApi } from "../src/http"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"

type Fixture = Awaited<ReturnType<typeof directoryFixture>>

async function upload(f: Fixture, purpose: "knowledge" | "artifact", text = "Original file") {
  return f.run(async () => {
    const bytes = new TextEncoder().encode(text)
    const upload = await OrganizationPublications.create(f.credentials.alice, {
      requestID: crypto.randomUUID(),
      purpose,
      scope: { kind: "project", projectID: "project" },
      ...(purpose === "artifact" ? { sourceSessionID: "source" } : {}),
    })
    const file = await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "result.txt",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: "text/plain",
    })
    await OrganizationPublications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    return OrganizationPublications.seal(f.credentials.alice, upload.uploadID, {
      fileCount: 1,
      totalBytes: bytes.length,
    })
  })
}

function receipt(f: Fixture, purpose: "knowledge" | "artifacts", body: unknown, actor = "alice") {
  return fetch(new URL(`/org/v1/${purpose}/publication-receipts`, f.baseUrl), {
    method: "POST",
    headers: {
      ...f.headers(actor),
      origin: "https://organization.example",
      "x-csrf-token": "f".repeat(64),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

test("mounted publication receipt operations require the original strict publication body", async () => {
  const spec = await organizationOpenApi()
  for (const [kind, operation] of [
    ["knowledge", "orgKnowledge.publicationReceipt"],
    ["artifacts", "orgArtifacts.publicationReceipt"],
  ]) {
    const route = spec.paths?.[`/org/v1/${kind}/publication-receipts`]?.post
    expect(route?.operationId).toBe(operation)
    expect(route?.requestBody).toMatchObject({ required: true })
    expect(route?.responses?.["200"]).toBeDefined()
  }
})

test("receipt reads observe missing without publishing and recover the original knowledge version after archive and restart", async () => {
  await using f = await directoryFixture()
  const sealed = await upload(f, "knowledge")
  const input = {
    requestID: "original-publish",
    itemID: "material",
    expectedRevision: 0,
    uploadID: sealed.uploadID,
    title: "Original title",
    kind: "material" as const,
  }
  const missing = await receipt(f, "knowledge", input)
  expect(missing.status).toBe(200)
  expect(await missing.json()).toEqual({ state: "missing" })
  expect((await f.run(() => OrganizationKnowledge.list(f.credentials.alice, { projectID: "project" }))).items).toEqual(
    [],
  )
  const first = await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, input))
  await f.run(() =>
    OrganizationKnowledge.publish(f.credentials.alice, {
      ...input,
      requestID: "second-publish",
      expectedRevision: 1,
      title: "Later title",
    }),
  )
  await f.run(() =>
    OrganizationProjects.update(f.credentials.alice, "project", {
      expectedRevision: 1,
      state: "archived",
    }),
  )
  await f.restart()
  const observed = await receipt(f, "knowledge", input)
  expect(observed.status).toBe(200)
  expect(await observed.json()).toEqual({ state: "published", release: first })
  const client = createOrganizationClient({
    baseUrl: f.baseUrl,
    headers: {
      ...f.headers("alice"),
      origin: "https://organization.example",
      "x-csrf-token": "f".repeat(64),
    },
  })
  expect((await client.orgKnowledge.publicationReceipt(input, { throwOnError: true })).data).toEqual({
    state: "published",
    release: first,
  })
  await expect(f.run(() => OrganizationKnowledge.publish(f.credentials.alice, input))).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED" },
  })
})

test("receipts bind the authenticated account and the complete original request before returning an authorized release", async () => {
  await using f = await directoryFixture()
  const sealed = await upload(f, "knowledge")
  const input = {
    requestID: "original-publish",
    itemID: "material",
    expectedRevision: 0,
    uploadID: sealed.uploadID,
    title: "Original title",
    kind: "material" as const,
  }
  await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, input))
  for (const changed of [{ title: "Changed" }, { itemID: "other" }, { expectedRevision: 1 }, { uploadID: "other" }]) {
    const response = await receipt(f, "knowledge", { ...input, ...changed })
    expect(response.status).toBe(409)
  }
  expect((await receipt(f, "knowledge", input, "bob")).status).toBe(404)
  expect((await receipt(f, "knowledge", input, "foreign")).status).toBe(404)
  expect((await receipt(f, "knowledge", { ...input, credential: "private" })).status).toBe(400)
  await f.run(() => Storage.remove(OrganizationStoragePath.projectMember("project", "alice")))
  const denied = await receipt(f, "knowledge", input)
  expect(denied.status).toBe(404)
  expect(JSON.stringify(await denied.json())).not.toContain("Original title")
})

test("an artifact receipt survives source removal and loss of write access without exposing the source", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
      sessionID: "source",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  const sealed = await upload(f, "artifact")
  const input = {
    requestID: "original-publish",
    artifactID: "report",
    expectedRevision: 0,
    uploadID: sealed.uploadID,
    title: "Original report",
  }
  expect(await (await receipt(f, "artifacts", input)).json()).toEqual({ state: "missing" })
  const first = await f.run(() => OrganizationArtifacts.publish(f.credentials.alice, input))
  await f.run(() =>
    OrganizationArtifacts.publish(f.credentials.alice, {
      ...input,
      requestID: "second-publish",
      expectedRevision: 1,
      title: "Later report",
    }),
  )
  await f.run(() => Storage.remove(OrganizationStoragePath.session("source")))
  await f.run(() =>
    OrganizationProjects.update(f.credentials.alice, "project", {
      expectedRevision: 1,
      state: "archived",
    }),
  )
  await f.restart()
  const response = await receipt(f, "artifacts", input)
  expect(response.status).toBe(200)
  const { sourceSessionID: _, ...safe } = first
  expect(await response.json()).toEqual({ state: "published", version: { ...safe, sourceAvailable: false } })
  const client = createOrganizationClient({
    baseUrl: f.baseUrl,
    headers: {
      ...f.headers("alice"),
      origin: "https://organization.example",
      "x-csrf-token": "f".repeat(64),
    },
  })
  expect((await client.orgArtifacts.publicationReceipt(input, { throwOnError: true })).data).toEqual({
    state: "published",
    version: { ...safe, sourceAvailable: false },
  })
  expect((await receipt(f, "artifacts", { ...input, artifactID: "other" })).status).toBe(409)
  expect((await receipt(f, "artifacts", { ...input, title: "Changed" })).status).toBe(409)
  expect((await receipt(f, "artifacts", input, "bob")).status).toBe(404)
  await f.run(() => Storage.remove(OrganizationStoragePath.projectMember("project", "alice")))
  expect((await receipt(f, "artifacts", input)).status).toBe(404)
})
