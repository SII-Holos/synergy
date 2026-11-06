import { chromium } from "playwright-core"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { createPptx } from "@ericsanchezok/synergy-testing/pptx"

async function archive(entries: Record<string, string>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, text] of Object.entries(entries)) await writer.add(name, new TextReader(text))
  return Buffer.from(await writer.close())
}

export async function mediaFixtures(executablePath: string) {
  const files: Array<{ filename: string; mime: string; marker: string; bytes: Buffer }> = []
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 220 }, deviceScaleFactor: 1 })
    for (const format of ["png", "jpeg", "pdf"] as const) {
      const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()
      await page.setContent(
        `<html><body style="margin:32px;color:black;background:white;font:48px monospace">Record identifier:<br>${marker}</body></html>`,
      )
      files.push({
        filename: format === "pdf" ? "record.pdf" : `visual.${format === "jpeg" ? "jpg" : format}`,
        mime: format === "pdf" ? "application/pdf" : `image/${format}`,
        marker,
        bytes: format === "pdf" ? await page.pdf({ format: "A4" }) : await page.screenshot({ type: format }),
      })
    }
  } finally {
    await browser.close()
  }
  for (const extension of ["docx", "xlsx", "pptx", "txt"] as const) {
    const marker = crypto.randomUUID().replaceAll("-", "").toUpperCase()
    const text = `Record identifier: ${marker}`
    const filename = `record.${extension}`
    if (extension === "txt") {
      files.push({ filename, mime: "text/plain", marker, bytes: Buffer.from(text) })
      continue
    }
    if (extension === "pptx") {
      files.push({
        filename,
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        marker,
        bytes: Buffer.from(await createPptx([text])),
      })
      continue
    }
    const main = extension === "docx" ? "word/document.xml" : "xl/workbook.xml"
    const type = extension === "docx" ? "wordprocessingml.document" : "spreadsheetml.sheet"
    const entries: Record<string, string> = {
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>${extension === "xlsx" ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ""}</Types>`,
      "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,
    }
    if (extension === "docx") {
      entries[main] =
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    } else {
      entries[main] =
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>'
      entries["xl/_rels/workbook.xml.rels"] =
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      entries["xl/worksheets/sheet1.xml"] =
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`
    }
    files.push({
      filename,
      mime: `application/vnd.openxmlformats-officedocument.${type}`,
      marker,
      bytes: await archive(entries),
    })
  }
  return files
}
