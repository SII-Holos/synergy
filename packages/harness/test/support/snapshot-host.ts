import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotRestore } from "../../src/session/snapshot-restore"

// This permissive fixture checks Harness object selection and binding admission.
// Atomic mutation, filesystem races and native ownership are tested in local-runtime.
export function registerSnapshotTestHost() {
  SnapshotRestore.register({
    async preview({ files }) {
      return Promise.all(
        files.map(async (file) => {
          const stat = await fs.lstat(file.file).catch(() => undefined)
          return {
            file: file.file,
            workspace: file.workspace,
            version: { entry: stat ? String(stat.mtimeMs) : null },
            before: stat ? await fs.readFile(file.file, "utf8") : "",
            after: new TextDecoder().decode(await file.read()),
            action: !file.mode ? ("delete" as const) : stat ? ("replace" as const) : ("create" as const),
            truncated: false,
            binary: false,
          }
        }),
      )
    },
    async restore({ files, signal }) {
      const restoredFiles: string[] = []
      for (const file of files) {
        signal?.throwIfAborted()
        if (!file.mode)
          await fs.unlink(file.file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
        else {
          const content = await file.read()
          await fs.mkdir(path.dirname(file.file), { recursive: true })
          await fs.unlink(file.file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
          if (file.mode === "120000") await fs.symlink(new TextDecoder().decode(content), file.file)
          else await fs.writeFile(file.file, content, { mode: file.mode === "100755" ? 0o755 : 0o644 })
        }
        restoredFiles.push(file.file)
      }
      return { restoredFiles, failedFiles: [] }
    },
  })
}
