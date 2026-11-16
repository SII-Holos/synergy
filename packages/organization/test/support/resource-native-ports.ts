import fs from "node:fs/promises"
import path from "node:path"
import type { OrganizationCloudOptions } from "../../src/cloud"

export function resourcePorts(original: string, received: string) {
  let allocations = 0
  let losePut: Error | undefined
  const cloud = (directory: string): OrganizationCloudOptions => ({
    blobStores: {
      files: {
        async put(hash, bytes) {
          await fs.writeFile(path.join(directory, hash), bytes)
          if (directory === received && losePut) {
            const error = losePut
            losePut = undefined
            throw error
          }
        },
        async get(hash, maximum) {
          const bytes = await fs.readFile(path.join(directory, hash))
          if (bytes.byteLength > maximum) throw new Error("Object exceeds its frame")
          return bytes
        },
      },
    },
    workspaceProfiles: { files: { blobStore: "files" } },
    environmentProviders: [
      {
        id: "idle-provider",
        async allocate() {
          allocations++
          throw new Error("Backup must not allocate compute")
        },
        async inspect() {
          return { state: "unknown" }
        },
        async deallocate() {
          throw new Error("No allocation exists")
        },
      },
    ],
    environmentProfiles: { compute: { provider: "idle-provider", spec: {} } },
  })
  return {
    sourceCloud: cloud(original),
    targetCloud: cloud(received),
    get allocations() {
      return allocations
    },
    loseNextPut(error: Error) {
      losePut = error
    },
  }
}
