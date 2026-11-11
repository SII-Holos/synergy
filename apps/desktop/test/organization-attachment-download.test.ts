import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { downloadOrganizationAttachment } from "../src/organization/content-download"
import { saveOrganizationDownload } from "../src/organization/download"
import { OrganizationReadProtocol as Read, type OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

const content = Buffer.from(Uint8Array.from({ length: 150_001 }, (_, index) => index % 256))
const binding = { schemaVersion: 1, orgID: "org", projectID: "project", creatorID: "creator", driverRuntimeID: "runtime", bindingEpoch: 1 } as const
const reference = { kind: "attachment", version: "part-v1", filename: "evidence.bin", mediaType: "application/octet-stream", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") } as const
const input: Desktop.AttachmentDownload = { requestID: "save-attachment", connectionID: "a".repeat(64), binding, query: { operation: "attachmentContent", rootSessionID: "root", sourceSessionID: "child", messageID: "message", partID: "part", version: "part-v1", offset: 0, length: 65_536 } }
function response(query: Read.Query, corrupt = false): Read.Result {
  if (query.operation !== "attachmentContent") throw new Error("Unexpected operation")
  const bytes = content.subarray(query.offset, query.offset + query.length)
  const data = corrupt ? Buffer.alloc(bytes.length, 120) : bytes
  return { operation: "attachmentContent", state: "ready", rootSessionID: query.rootSessionID, sourceSessionID: query.sourceSessionID ?? query.rootSessionID, binding, messageID: query.messageID, partID: query.partID, reference, chunk: { offset: query.offset, nextOffset: query.offset + data.length, totalBytes: content.length, sha256: reference.sha256, data: data.toString("base64url"), complete: query.offset + data.length === content.length } }
}
function unavailable(query: Read.Query): Read.Result {
  if (query.operation !== "attachmentContent") throw new Error("Unexpected operation")
  return { operation: "attachmentContent", state: "unavailable", rootSessionID: query.rootSessionID, sourceSessionID: query.sourceSessionID ?? query.rootSessionID, binding, messageID: query.messageID, partID: query.partID, version: query.version, reason: "partial" }
}

test("attachment saving obtains its native descriptor before the picker and publishes verified binary chunks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "organization-attachment-"))
  const target = path.join(directory, "chosen.bin")
  const queries: Read.Query[] = []
  const controller = new AbortController()
  const save = (fileName: string, write: (append: (bytes: Uint8Array) => Promise<void>) => Promise<number>) => {
    expect(fileName).toBe("evidence.bin")
    expect(queries).toHaveLength(1)
    return saveOrganizationDownload({ fileName, signal: controller.signal, choose: async () => target, write })
  }
  try {
    const result = await downloadOrganizationAttachment(input, { signal: controller.signal, read: async (query) => { queries.push(query); return response(query) }, save })
    expect(result).toEqual({ kind: "result", result: { saved: true, bytes: content.length } })
    expect(await fs.readFile(target)).toEqual(content)
    expect(queries.every((query) => query.operation === "attachmentContent" && query.length <= 65_536)).toBe(true)
    expect(queries).toHaveLength(4)
    expect(await fs.readdir(directory)).toEqual(["chosen.bin"])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("unretained native attachment evidence does not open the save picker", async () => {
  let saves = 0
  const result = await downloadOrganizationAttachment(input, { signal: new AbortController().signal, read: async (query) => unavailable(query), save: async () => { saves++; return { saved: false } } })
  expect(result).toEqual({ kind: "unavailable", version: "part-v1", reason: "partial" })
  expect(saves).toBe(0)
})

test("late unavailable evidence and corrupt attachment bytes preserve the existing target and remove temporary files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "organization-attachment-"))
  const target = path.join(directory, "chosen.bin")
  const signal = new AbortController().signal
  await fs.writeFile(target, "Previous file")
  const save = (fileName: string, write: (append: (bytes: Uint8Array) => Promise<void>) => Promise<number>) => saveOrganizationDownload({ fileName, signal, choose: async () => target, write })
  try {
    const result = await downloadOrganizationAttachment(input, { signal, save, read: async (query) => query.operation === "attachmentContent" && query.offset > 0 ? unavailable(query) : response(query) })
    expect(result).toEqual({ kind: "unavailable", version: "part-v1", reason: "partial" })
    await expect(downloadOrganizationAttachment(input, { signal, save, read: async (query) => response(query, true) })).rejects.toThrow()
    expect(await fs.readFile(target, "utf8")).toBe("Previous file")
    expect(await fs.readdir(directory)).toEqual(["chosen.bin"])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("cancellation and changed immutable descriptors after the picker never publish attachment bytes", async () => {
  for (const changed of [false, true]) {
    let writes = 0
    const controller = new AbortController()
    await expect(downloadOrganizationAttachment(input, { signal: controller.signal, read: async (query) => {
      const result = response(query)
      return changed && writes === 0 && query.operation === "attachmentContent" && query.length > 1 && result.operation === "attachmentContent" && result.state === "ready" ? { ...result, reference: { ...result.reference, filename: "changed.bin" } } : result
    }, save: async (_fileName, write) => {
      if (!changed) controller.abort(new Error("Cancel selected download"))
      return { saved: true, bytes: await write(async () => { writes++ }) }
    } })).rejects.toThrow()
    expect(writes).toBe(0)
  }
})
