import { expect, test } from "bun:test"
import { zipSync, strToU8, unzipSync } from "fflate"
import { validateOfficePackage, OfficePreviewError } from "../../../src/components/attachment-workbench/office-package"

const contentType =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
function documentFile(extra: Record<string, Uint8Array> = {}) {
  return zipSync({
    "[Content_Types].xml": strToU8(contentType),
    "word/document.xml": strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文内容</w:t></w:r></w:p></w:body></w:document>',
    ),
    ...extra,
  })
}

test("Office validation retains document bytes while excluding external relationships and active parts", () => {
  const input = documentFile({
    "word/_rels/document.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="image" Target="https://example.com/tracker.png" TargetMode="External"/><Relationship Id="local" Type="image" Target="media/image.png"/></Relationships>',
    ),
    "word/vbaProject.bin": new Uint8Array([1]),
    "word/media/image.png": new Uint8Array([2]),
  })
  const checked = validateOfficePackage(input, "docx")
  const files = unzipSync(checked.bytes)
  expect(new TextDecoder().decode(files["word/document.xml"])).toContain("中文内容")
  expect(new TextDecoder().decode(files["word/_rels/document.xml.rels"])).not.toContain("https:")
  expect(new TextDecoder().decode(files["word/_rels/document.xml.rels"])).toContain('Id="local"')
  expect(files["word/vbaProject.bin"]).toBeUndefined()
})

test("Office validation limits actual decoded bytes, input size and entry count", () => {
  expect(() =>
    validateOfficePackage(documentFile({ "word/large.xml": new Uint8Array(1024).fill(65) }), "docx", {
      maxExpandedBytes: 500,
    }),
  ).toThrow(OfficePreviewError)
  expect(() => validateOfficePackage(documentFile(), "docx", { maxInputBytes: 10 })).toThrow(OfficePreviewError)
  expect(() => validateOfficePackage(documentFile(), "docx", { maxEntries: 1 })).toThrow(OfficePreviewError)
})

test("Office validation distinguishes corrupt, encrypted and incompatible packages", () => {
  expect(() => validateOfficePackage(new Uint8Array([1, 2]), "docx")).toThrow("corrupt")
  expect(() => validateOfficePackage(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "docx")).toThrow(
    "encrypted",
  )
  expect(() => validateOfficePackage(documentFile(), "xlsx")).toThrow("unsupported")
})

test("forged ZIP size metadata cannot bypass decoded byte limits and CRC corruption is rejected", () => {
  const bytes = documentFile({ "word/large.xml": new Uint8Array(4096).fill(65) })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset + 46 < bytes.length; offset++)
    if (
      view.getUint32(offset, true) === 0x02014b50 &&
      new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + view.getUint16(offset + 28, true))) ===
        "word/large.xml"
    )
      view.setUint32(offset + 24, 0, true)
  expect(() => validateOfficePackage(bytes, "docx", { maxExpandedBytes: 300 })).toThrow("too-large")
  const corrupt = documentFile()
  const corruptView = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength)
  for (let offset = 0; offset + 46 < corrupt.length; offset++)
    if (corruptView.getUint32(offset, true) === 0x02014b50) {
      corruptView.setUint32(offset + 16, 123, true)
      break
    }
  expect(() => validateOfficePackage(corrupt, "docx")).toThrow("corrupt")
})
