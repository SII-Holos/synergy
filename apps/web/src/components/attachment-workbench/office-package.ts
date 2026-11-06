import { Unzip, UnzipInflate, strToU8, zipSync } from "fflate"
import { SaxesParser } from "saxes"

import {
  OfficePreviewError,
  OFFICE_INPUT_MAX_BYTES,
  OFFICE_EXPANDED_MAX_BYTES,
  OFFICE_MAX_ENTRIES,
  type OfficeFormat,
} from "./office-contract"
export {
  OfficePreviewError,
  OFFICE_INPUT_MAX_BYTES,
  OFFICE_EXPANDED_MAX_BYTES,
  OFFICE_MAX_ENTRIES,
} from "./office-contract"
export type { OfficeFormat, OfficeErrorCode } from "./office-contract"

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function centralDirectory(bytes: Uint8Array, maxEntries: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break
  }
  if (end < 0 || end < bytes.length - 65557) throw new OfficePreviewError("corrupt")
  const count = view.getUint16(end + 10, true)
  if (count > maxEntries) throw new OfficePreviewError("too-large")
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new OfficePreviewError("unsupported")
  const size = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  if (offset + size > end) throw new OfficePreviewError("corrupt")
  const entries = new Map<string, { size: number; crc: number; method: number }>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new OfficePreviewError("corrupt")
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    if (flags & 0x41 || method === 99) throw new OfficePreviewError("encrypted")
    if (method !== 0 && method !== 8) throw new OfficePreviewError("unsupported")
    const length = view.getUint16(offset + 28, true)
    const recordSize = 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    if (offset + recordSize > end || local + 30 > offset || view.getUint32(local, true) !== 0x04034b50)
      throw new OfficePreviewError("corrupt")
    if (view.getUint16(local + 6, true) & 0x41) throw new OfficePreviewError("encrypted")
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length))
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").includes("..") ||
      entries.has(name)
    )
      throw new OfficePreviewError("corrupt")
    entries.set(name, { size: view.getUint32(offset + 24, true), crc: view.getUint32(offset + 16, true), method })
    offset += recordSize
  }
  if (offset !== view.getUint32(end + 16, true) + size) throw new OfficePreviewError("corrupt")
  return entries
}

function escapeXml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
}

function safeRelationships(bytes: Uint8Array) {
  const parser = new SaxesParser({ xmlns: true })
  let output = "",
    skipped = 0
  parser.on("doctype", () => {
    throw new OfficePreviewError("corrupt")
  })
  parser.on("opentag", (node) => {
    if (skipped) {
      skipped++
      return
    }
    const values = Object.fromEntries(Object.values(node.attributes).map((attr) => [attr.local, attr.value]))
    if (
      node.local === "Relationship" &&
      (values.TargetMode?.toLowerCase() === "external" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(values.Target ?? ""))
    ) {
      skipped = 1
      return
    }
    output += `<${node.name}${Object.values(node.attributes)
      .map((attr) => ` ${attr.name}="${escapeXml(attr.value)}"`)
      .join("")}>`
  })
  parser.on("closetag", (node) => {
    if (skipped) skipped--
    else output += `</${node.name}>`
  })
  parser.on("text", (text) => {
    if (!skipped) output += escapeXml(text)
  })
  parser.on("cdata", (text) => {
    if (!skipped) output += escapeXml(text)
  })
  parser.write(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).close()
  return strToU8(output)
}

export function validateOfficePackage(
  bytes: Uint8Array,
  format: OfficeFormat,
  limits: { maxInputBytes?: number; maxExpandedBytes?: number; maxEntries?: number } = {},
): { bytes: Uint8Array; expandedBytes: number; entryCount: number } {
  if (bytes.length > (limits.maxInputBytes ?? OFFICE_INPUT_MAX_BYTES)) throw new OfficePreviewError("too-large")
  if (
    bytes.length >= 8 &&
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value)
  )
    throw new OfficePreviewError("encrypted")
  try {
    const expected = centralDirectory(bytes, limits.maxEntries ?? OFFICE_MAX_ENTRIES)
    const maxExpanded = limits.maxExpandedBytes ?? OFFICE_EXPANDED_MAX_BYTES
    const entries: Record<string, Uint8Array> = Object.create(null)
    let total = 0,
      count = 0,
      failure: OfficePreviewError | undefined
    const unzip = new Unzip((file) => {
      count++
      const metadata = expected.get(file.name)
      if (!metadata || file.compression !== metadata.method || entries[file.name])
        throw new OfficePreviewError("corrupt")
      let crc = 0xffffffff,
        size = 0
      const chunks: Uint8Array[] = []
      file.ondata = (error, chunk, final) => {
        if (failure) return
        if (error) {
          failure = new OfficePreviewError("corrupt")
          return
        }
        total += chunk.length
        size += chunk.length
        if (total > maxExpanded) {
          failure = new OfficePreviewError("too-large")
          file.terminate()
          return
        }
        for (const value of chunk) crc = crcTable[(crc ^ value) & 255]! ^ (crc >>> 8)
        chunks.push(chunk)
        if (!final) return
        if (size !== metadata.size || (crc ^ 0xffffffff) >>> 0 !== metadata.crc) {
          failure = new OfficePreviewError("corrupt")
          return
        }
        const data = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.length
        }
        entries[file.name] = data
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length)
      if (failure) throw failure
    }
    if (count !== expected.size || Object.keys(entries).length !== expected.size)
      throw new OfficePreviewError("corrupt")
    const main = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[format]
    if (!entries["[Content_Types].xml"] || !entries[main]) throw new OfficePreviewError("unsupported")
    for (const name of Object.keys(entries)) {
      if (/(?:vbaProject|activeX|embeddings|webextensions|externalLinks|connections\.xml|customUI)/i.test(name))
        delete entries[name]
      else if (name.endsWith(".rels")) entries[name] = safeRelationships(entries[name]!)
    }
    return { bytes: zipSync(entries, { level: 1 }), expandedBytes: total, entryCount: count }
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error
    throw new OfficePreviewError("corrupt")
  }
}
