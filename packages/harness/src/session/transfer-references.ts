import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { markdownAssetReferencesComplete } from "@ericsanchezok/synergy-util/markdown-assets"
import type { SessionTransferOwners } from "./transfer-owners"

export namespace SessionTransferReferences {
  export function* markdown(text: string): Generator<SessionTransferOwners.Dependency> {
    for (const reference of markdownAssetReferencesComplete(text)) yield { kind: "asset", reference }
  }

  export function* value(input: unknown): Generator<SessionTransferOwners.Dependency> {
    if (typeof input === "string") {
      const asset = AssetReference.parse(input)
      if (asset) yield { kind: "asset", reference: asset.url }
      if (input.startsWith("tool-output://")) yield { kind: "tool-output", reference: input }
      return
    }
    if (!input || typeof input !== "object") return
    if (Array.isArray(input)) {
      for (const child of input) yield* value(child)
      return
    }
    for (const key in input) if (Object.hasOwn(input, key)) yield* value(Reflect.get(input, key))
  }

  export function* result(input: unknown): Generator<SessionTransferOwners.Dependency> {
    yield* value(input)
    if (!input || typeof input !== "object") return
    const output = Reflect.get(input, "output")
    if (typeof output === "string") yield* markdown(output)
  }
}
