import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function declarePptxSlideSizes(bytes: Uint8Array, sizes: number[]): Uint8Array {
  const output = bytes.slice()
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  const decoder = new TextDecoder()
  for (let offset = 0; offset <= output.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue

    const filenameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const filenameStart = offset + 46
    const filename = decoder.decode(output.subarray(filenameStart, filenameStart + filenameLength))
    const match = filename.match(/^ppt\/slides\/slide(\d+)\.xml$/)
    if (match) {
      const declaredSize = sizes[Number.parseInt(match[1]) - 1]
      if (declaredSize !== undefined) view.setUint32(offset + 24, declaredSize, true)
    }
    offset = filenameStart + filenameLength + extraLength + commentLength - 1
  }
  return output
}

export async function createPptx(slides: string[]): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await writer.add(
    "[Content_Types].xml",
    new TextReader(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
  )
  await writer.add(
    "ppt/presentation.xml",
    new TextReader(
      '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    ),
  )
  for (const [index, text] of slides.entries()) {
    await writer.add(
      `ppt/slides/slide${index + 1}.xml`,
      new TextReader(
        `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ),
    )
  }
  return writer.close()
}
