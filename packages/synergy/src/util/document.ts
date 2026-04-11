import * as path from "path"

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"])

export namespace Document {
  export function supported(filepath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filepath).toLowerCase())
  }

  export async function extractText(filepath: string): Promise<string> {
    const ext = path.extname(filepath).toLowerCase()
    switch (ext) {
      case ".pdf":
        return extractPdf(filepath)
      case ".docx":
        return extractDocx(filepath)
      case ".xlsx":
        return extractXlsx(filepath)
      case ".pptx":
        return extractPptx(filepath)
      default:
        throw new Error(`Unsupported document format: ${ext}`)
    }
  }
}

async function extractPdf(filepath: string): Promise<string> {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const { extractText, getDocumentProxy } = await import("unpdf")
    const buffer = await Bun.file(filepath).arrayBuffer()
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const result = await extractText(pdf, { mergePages: true })
    return result.text
  } finally {
    console.warn = originalWarn
  }
}

async function extractDocx(filepath: string): Promise<string> {
  const mammoth = await import("mammoth")
  const result = await mammoth.default.extractRawText({ path: filepath })
  return result.value
}

async function extractXlsx(filepath: string): Promise<string> {
  const XLSX = await import("xlsx")
  const buffer = await Bun.file(filepath).arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })
  const sheets: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    if (csv.trim()) {
      sheets.push(`[Sheet: ${name}]\n${csv}`)
    }
  }
  return sheets.join("\n\n")
}

async function extractPptx(filepath: string): Promise<string> {
  const { ZipReader, Uint8ArrayReader, TextWriter } = await import("@zip.js/zip.js")
  const bytes = await Bun.file(filepath).bytes()
  const reader = new ZipReader(new Uint8ArrayReader(bytes))
  const entries = await reader.getEntries()

  const slides: { index: number; text: string }[] = []
  for (const entry of entries) {
    if (entry.directory) continue
    const match = entry.filename.match(/^ppt\/slides\/slide(\d+)\.xml$/)
    if (!match) continue

    const xml = await entry.getData!(new TextWriter())
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]))
    if (texts.length > 0) {
      slides.push({ index: parseInt(match[1]), text: texts.join(" ") })
    }
  }

  await reader.close()

  slides.sort((a, b) => a.index - b.index)
  return slides.map((s) => `[Slide ${s.index}]\n${s.text}`).join("\n\n")
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
