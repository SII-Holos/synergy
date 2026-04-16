import fs from "fs/promises"

export namespace DaemonLogTail {
  export async function tailFile(filePath: string, lineCount: number) {
    const content = await readText(filePath)
    if (!content) return ""
    const lines = content.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    return lines.slice(-lineCount).join("\n")
  }

  export async function followFile(filePath: string, lineCount: number, onChunk: (chunk: string) => void) {
    const size = await fileSize(filePath)
    const content = await readText(filePath)
    if (content) {
      const lines = content.split(/\r?\n/)
      if (lines.at(-1) === "") lines.pop()
      const tail = lines.slice(-lineCount).join("\n")
      if (tail) onChunk(tail + "\n")
    }

    let offset = size
    let lastInode = await fileInode(filePath)

    while (true) {
      await Bun.sleep(500)

      const currentInode = await fileInode(filePath)
      if (currentInode !== lastInode) {
        offset = 0
        lastInode = currentInode
      }

      const nextSize = await fileSize(filePath)
      if (nextSize < offset) {
        offset = 0
      }
      if (nextSize === offset) {
        continue
      }
      const file = Bun.file(filePath)
      const chunk = await file.slice(offset, nextSize).text()
      offset = nextSize
      if (chunk) onChunk(chunk)
    }
  }

  async function readText(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists().catch(() => false))) return ""
    return await file.text().catch(() => "")
  }

  async function fileSize(filePath: string) {
    try {
      const stat = await fs.stat(filePath)
      return stat.size
    } catch {
      return 0
    }
  }

  async function fileInode(filePath: string) {
    try {
      const stat = await fs.stat(filePath)
      return stat.ino
    } catch {
      return 0
    }
  }
}
