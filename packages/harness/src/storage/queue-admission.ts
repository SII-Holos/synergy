import { AsyncLocalStorage } from "node:async_hooks"
import type { StorageQueueOptions } from "./queue"

export const nativeAdmissionGuard = Symbol("native-storage-admission")
export interface StorageAdmission extends StorageQueueOptions {
  [nativeAdmissionGuard]?: () => void
}
export const storageAdmission = new AsyncLocalStorage<StorageAdmission>()
