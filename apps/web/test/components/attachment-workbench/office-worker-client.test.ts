import { expect, test } from "bun:test"
import {
  createOfficeWorkerReader,
  type OfficeWorkerResponse,
} from "../../../src/components/attachment-workbench/office-worker-client"

class PreviewWorker {
  onmessage: Worker["onmessage"] = null
  onerror: Worker["onerror"] = null
  terminated = 0
  postMessage() {}
  terminate() {
    this.terminated++
  }
  reply(data: OfficeWorkerResponse) {
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data }))
  }
}

test("closing or replacing an Office read terminates workers and rejects late replies", async () => {
  const workers: PreviewWorker[] = []
  const reader = createOfficeWorkerReader(() => {
    const worker = new PreviewWorker()
    workers.push(worker)
    return worker
  })
  const first = reader.read(new Uint8Array([1]), "docx")
  const second = reader.read(new Uint8Array([2]), "docx")
  workers[0]!.reply({ ok: true, value: { bytes: new Uint8Array([99]), expandedBytes: 1, entryCount: 1 } })
  await expect(first).rejects.toMatchObject({ name: "AbortError" })
  workers[1]!.reply({ ok: true, value: { bytes: new Uint8Array([2]), expandedBytes: 1, entryCount: 1 } })
  expect((await second).bytes[0]).toBe(2)
  expect(workers.map((worker) => worker.terminated)).toEqual([1, 1])
  const third = reader.read(new Uint8Array([3]), "docx")
  reader.cancel()
  await expect(third).rejects.toMatchObject({ name: "AbortError" })
})
