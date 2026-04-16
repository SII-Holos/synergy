export type FileSnapshot = Map<string, string>

export async function snapshotFiles(filePaths: readonly string[]): Promise<FileSnapshot> {
  const snapshot = new Map<string, string>()
  for (const filePath of filePaths) {
    snapshot.set(filePath, await Bun.file(filePath).text())
  }
  return snapshot
}

export async function restoreFiles(snapshot: FileSnapshot) {
  for (const [filePath, content] of snapshot.entries()) {
    await Bun.write(filePath, content)
  }
}
