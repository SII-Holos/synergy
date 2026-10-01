import { validateOfficePackage, OfficePreviewError } from "./office-package"
import type { OfficeWorkerRequest, OfficeWorkerResponse } from "./office-worker-client"

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<OfficeWorkerRequest>) => void
  postMessage: (message: OfficeWorkerResponse, transfer?: Transferable[]) => void
}
workerScope.onmessage = async (event) => {
  try {
    if (event.data.kind === "xlsx") {
      const { parseOfficeSpreadsheet } = await import("./xlsx-parser")
      workerScope.postMessage({ ok: true, kind: "xlsx", value: parseOfficeSpreadsheet(event.data.bytes) })
      return
    }
    const value = validateOfficePackage(event.data.bytes, event.data.format)
    workerScope.postMessage({ ok: true, kind: "check", value }, [value.bytes.buffer as ArrayBuffer])
  } catch (error) {
    workerScope.postMessage({ ok: false, code: error instanceof OfficePreviewError ? error.code : "failed" })
  }
}
