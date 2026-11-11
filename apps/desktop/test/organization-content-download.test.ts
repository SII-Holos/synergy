import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { saveOrganizationDownload } from "../src/organization/download"
import { downloadOrganizationContent } from "../src/organization/content-download"
import { OrganizationReadProtocol as Read, type OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

const bytes = Buffer.from("Native content 内容\n".repeat(15000))
const digest = createHash("sha256").update(bytes).digest("hex")
const binding = {schemaVersion:1 as const,orgID:"org-a",projectID:"project-a",creatorID:"account-a",driverRuntimeID:"runtime-a",bindingEpoch:1}
const reference = {kind:"native" as const,version:"v1",field:"text" as const,bytes:bytes.length,sha256:digest,original:"partial" as const}
const input: Desktop.ContentDownload = {requestID:"download-a",connectionID:"a".repeat(64),fileName:"result.txt",binding,reference,query:{operation:"partContent",rootSessionID:"session-a",messageID:"message-a",partID:"part-a",field:"text",version:"v1",offset:0,length:131072}}
function read(queries: Read.Query[], corrupt=false) {
  return async (query:Read.Query):Promise<Read.Result> => {
    queries.push(query)
    if (query.operation !== "partContent") throw new Error("Unexpected operation")
    const chunk = bytes.subarray(query.offset,query.offset+query.length)
    const data = corrupt ? Buffer.alloc(chunk.length,120) : chunk
    return {operation:"partContent",state:"ready",rootSessionID:query.rootSessionID,sourceSessionID:query.sourceSessionID ?? query.rootSessionID,binding,value:{messageID:query.messageID,partID:query.partID,version:"v1",part:{type:"text",content:reference}},chunk:{field:"text",offset:query.offset,nextOffset:query.offset+data.length,totalBytes:bytes.length,sha256:digest,original:"partial",data:data.toString("base64url"),complete:query.offset+data.length===bytes.length}}
  }
}

test("native field saving writes bounded verified chunks atomically and retains partial provenance", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"organization-content-"))
  const target = path.join(directory,"result.txt")
  const queries:Read.Query[]=[]
  const signal = new AbortController().signal
  try {
    const outcome = await downloadOrganizationContent(input,{
      signal,read:read(queries),save:(fileName,write) => saveOrganizationDownload({fileName,signal,choose:async () => target,write}),
    })
    expect(outcome).toEqual({kind:"result",result:{saved:true,bytes:bytes.length},original:"partial"})
    expect(new Uint8Array(await fs.readFile(target))).toEqual(new Uint8Array(bytes))
    expect(queries.length).toBeGreaterThan(3)
    expect(queries.every((query) => query.operation === "partContent" && query.length <= 131072)).toBe(true)
    await expect(downloadOrganizationContent(input,{
      signal,read:read([],true),save:(fileName,write) => saveOrganizationDownload({fileName,signal,choose:async () => target,write}),
    })).rejects.toThrow()
    expect(new Uint8Array(await fs.readFile(target))).toEqual(new Uint8Array(bytes))
    expect(await fs.readdir(directory)).toEqual(["result.txt"])
  } finally { await fs.rm(directory,{recursive:true,force:true}) }
})

test("pending native materialization never opens a save dialog or publishes an empty file", async () => {
  let saves=0
  const result = await downloadOrganizationContent(input,{
    signal:new AbortController().signal,
    read:async () => ({operation:"partContent",state:"preparing",rootSessionID:"session-a",sourceSessionID:"session-a",binding,messageID:"message-a",partID:"part-a",version:"v1",progress:{phase:"materializing",bytes:20}}),
    save:async () => {saves++;return {saved:false}},
  })
  expect(result).toEqual({kind:"preparing",version:"v1",progress:{phase:"materializing",bytes:20}})
  expect(saves).toBe(0)
})

test("preparation after a verified prefix removes staged bytes and preserves the chosen target", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"organization-content-"))
  const target = path.join(directory,"result.txt")
  await fs.writeFile(target,"Original file")
  const signal = new AbortController().signal
  const ready = read([])
  try {
    const outcome = await downloadOrganizationContent(input,{
      signal,
      read:async (query) => query.operation === "partContent" && query.offset > 0
        ? {operation:"partContent",state:"preparing",rootSessionID:"session-a",sourceSessionID:"session-a",binding,messageID:"message-a",partID:"part-a",version:"v1",progress:{phase:"busy",bytes:query.offset}}
        : ready(query),
      save:(fileName,write) => saveOrganizationDownload({fileName,signal,choose:async () => target,write}),
    })
    expect(outcome).toMatchObject({kind:"preparing",version:"v1",progress:{phase:"busy",bytes:131072}})
    expect(await fs.readFile(target,"utf8")).toBe("Original file")
    expect(await fs.readdir(directory)).toEqual(["result.txt"])
  } finally {await fs.rm(directory,{recursive:true,force:true})}
})
