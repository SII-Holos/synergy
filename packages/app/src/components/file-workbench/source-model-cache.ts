type MonacoModel = import("monaco-editor").editor.ITextModel

export type FileSourceModelEntry = { model: MonacoModel; bytes: number; touched: number }

const MAX_MODELS = 12
const MAX_MODEL_BYTES = 24 * 1024 * 1024
const models = new Map<string, FileSourceModelEntry>()

export function getFileSourceModel(uri: string) {
  return models.get(uri)
}

export function setFileSourceModel(uri: string, entry: FileSourceModelEntry) {
  models.set(uri, entry)
}

export function pruneFileSourceModels(protectedUri: string) {
  let bytes = Array.from(models.values()).reduce((total, entry) => total + entry.bytes, 0)
  if (models.size <= MAX_MODELS && bytes <= MAX_MODEL_BYTES) return
  const candidates = Array.from(models.entries())
    .filter(([uri]) => uri !== protectedUri)
    .toSorted((a, b) => a[1].touched - b[1].touched)
  for (const [uri, entry] of candidates) {
    if (models.size <= MAX_MODELS && bytes <= MAX_MODEL_BYTES) break
    entry.model.dispose()
    models.delete(uri)
    bytes -= entry.bytes
  }
}

export function releaseFileSourceScope(scopeKey: string) {
  const authority = encodeURIComponent(scopeKey)
  for (const [uri, entry] of models) {
    if (entry.model.uri.authority !== authority) continue
    entry.model.dispose()
    models.delete(uri)
  }
}
