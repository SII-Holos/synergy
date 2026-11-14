import { createHash } from "node:crypto"

export function browserProfilePartition(ownerKey: string): string {
  return `persist:synergy-browser-${createHash("sha256").update(ownerKey).digest("hex")}`
}

function runtimeDigest(runtimeKey: string, identity: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runtimeKey)) throw new Error("Invalid native Browser Runtime identity.")
  return createHash("sha256")
    .update(JSON.stringify([runtimeKey, identity]))
    .digest("hex")
}

export function browserRuntimeOwnerKey(runtimeKey: string | undefined, ownerKey: string) {
  return runtimeKey === undefined ? ownerKey : `runtime:${runtimeDigest(runtimeKey, ownerKey)}`
}

export function browserRuntimePartition(runtimeKey: string | undefined, partition: string) {
  if (!/^(persist:)?synergy-browser-[a-zA-Z0-9._-]+$/.test(partition)) throw new Error("Invalid browser partition.")
  if (runtimeKey === undefined) return partition
  return `${partition.startsWith("persist:") ? "persist:" : ""}synergy-browser-member-${runtimeDigest(runtimeKey, partition)}`
}
