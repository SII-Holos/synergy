import path from "node:path"
import { createBrowserFixture } from "./browser-fixture"

export function officeReaderFixture() {
  return createBrowserFixture({
    root: path.resolve(import.meta.dir, "../fixtures/office"),
    entries: ["docx.html", "xlsx.html", "pptx.html"],
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }],
  })
}
