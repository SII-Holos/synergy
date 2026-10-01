import { OfficePreviewError, type OfficeFormat, type OfficeErrorCode } from "./office-contract"

export interface CheckedOfficePackage {
  bytes: Uint8Array
  expandedBytes: number
  entryCount: number
}
export interface OfficeWorkerRequest {
  kind: "check"
  format: OfficeFormat
  bytes: Uint8Array
}
export type OfficeWorkerResponse = { ok: true; value: CheckedOfficePackage } | { ok: false; code: OfficeErrorCode }

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
  return {
    cancel,
    read(bytes: Uint8Array, format: OfficeFormat) {
      cancel()
      const worker = factory()
      return new Promise<CheckedOfficePackage>((resolve, reject) => {
        const current = { worker, reject }
        active = current
        const finish = () => {
          worker.terminate()
          if (active === current) active = undefined
        }
        worker.onmessage = (event: MessageEvent<OfficeWorkerResponse>) => {
          if (active !== current) return
          finish()
          if (event.data.ok) resolve(event.data.value)
          else reject(new OfficePreviewError(event.data.code))
        }
        worker.onerror = () => {
          if (active !== current) return
          finish()
          reject(new OfficePreviewError("failed"))
        }
        const copy = new Uint8Array(bytes)
        worker.postMessage({ kind: "check", format, bytes: copy } satisfies OfficeWorkerRequest, [copy.buffer])
      })
    },
  }
}
