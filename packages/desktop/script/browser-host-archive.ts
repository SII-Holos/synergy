import unzipper from "unzipper"

export async function assertBrowserHostArchive(data: Buffer, executable: string): Promise<void> {
  const archive = await unzipper.Open.buffer(data)
  const expected = executable.replace(/\\/g, "/")
  const entries = new Set(archive.files.map((entry) => entry.path.replace(/\\/g, "/")))
  if (!entries.has(expected)) {
    throw new Error(`Browser Host archive does not contain its manifest executable: ${executable}`)
  }
}
