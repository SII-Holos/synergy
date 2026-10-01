import { OfficePreviewError, type OfficeFormat, type OfficeErrorCode } from "./office-contract"

export interface CheckedOfficePackage {
  bytes: Uint8Array
  expandedBytes: number
  entryCount: number
}
export type OfficeWorkerRequest =
  | { kind: "check"; format: OfficeFormat; bytes: Uint8Array }
  | { kind: "xlsx"; bytes: Uint8Array }
export type OfficeWorkerResponse =
  | { ok: true; kind: "check"; value: CheckedOfficePackage }
  | { ok: true; kind: "xlsx"; value: import("./xlsx-model").SpreadsheetPreview }
  | { ok: false; code: OfficeErrorCode }

type PreviewWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">

export function createOfficeWorkerReader(
  factory: () => PreviewWorker = () => new Worker(new URL("./office-worker.ts", import.meta.url), { type: "module" }),
) {
  let active: { worker: PreviewWorker; reject: (reason: unknown) => void } | undefined
  const cancel = () => {
    if (!active) return
    active.worker.terminate()
    active.reject(new DOMException("Cancelled", "AbortError"))
    active = undefined
  }
  const run = (request: OfficeWorkerRequest) => {
    cancel()
    const worker = factory()
    return new Promise<Extract<OfficeWorkerResponse, { ok: true }>>((resolve, reject) => {
      const current = { worker, reject }
      active = current
      const finish = () => {
        worker.terminate()
        if (active === current) active = undefined
      }
      worker.onmessage = (event: MessageEvent<OfficeWorkerResponse>) => {
        if (active !== current) return
        finish()
        if (event.data.ok) resolve(event.data)
        else reject(new OfficePreviewError(event.data.code))
      }
      worker.onerror = () => {
        if (active !== current) return
        finish()
        reject(new OfficePreviewError("failed"))
      }
      const copy = new Uint8Array(request.bytes)
      worker.postMessage({ ...request, bytes: copy }, [copy.buffer])
    })
  }
  return {
    cancel,
    read: async (bytes: Uint8Array, format: OfficeFormat) => {
      const result = await run({ kind: "check", format, bytes })
      if (result.kind !== "check") throw new OfficePreviewError("failed")
      return result.value
    },
    readSpreadsheet: async (bytes: Uint8Array) => {
      const result = await run({ kind: "xlsx", bytes })
      if (result.kind !== "xlsx") throw new OfficePreviewError("failed")
      return result.value
    },
  }
}
