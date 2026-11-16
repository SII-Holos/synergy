import { SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { NativeWorkspacePortableTarget as Native } from "./workspace/portable-target"
import { NativeWorkspaceAdoption as Adoption } from "./workspace/native-adoption"
import { NativeWorkspaceDownload as Download } from "./workspace/native-download"

export function registerSessionTransferWorkspaceTarget() {
  Files.registerTargetHost({
    async prepare({ handoffID, captured, store, signal, mode }) {
      if (mode === "existing") return Adoption.prepare({ handoffID, captured, store, signal, mode })
      if (mode === "download") return Download.prepare({ handoffID, captured, store, signal, mode })
      const receipt = await Native.prepare({
        handoffID,
        workspaceID: captured.workspaceID,
        scopeID: captured.scopeID,
        files: captured.files,
        store,
        signal,
      })
      return {
        version: 1,
        workspaceID: receipt.workspaceID,
        scopeID: receipt.scopeID,
        hostID: receipt.hostID,
        path: receipt.directory,
        physicalID: receipt.physicalID,
        receipt: JsonValue.parse(receipt),
      }
    },
    async validate(value, signal) {
      if (value.version === 2) return Download.validate(value, signal)
      const adoption = Adoption.parse(value.receipt)
      if (adoption) return Adoption.validate(Adoption.selection(value), signal)
      await Native.validate(Native.Receipt.parse(value.receipt), signal)
    },
    withPublication(values, signal, body) {
      if (values.some((value) => value.version === 2)) {
        if (values.some((value) => value.version !== 2))
          throw new Error("Native target cannot mix private download and other preparations")
        return Download.withPublication(values, signal, body)
      }
      const first = values[0] && Adoption.parse(values[0].receipt)
      if (first)
        return Adoption.withPublication(
          values.map((value) => Adoption.selection(value)),
          signal,
          body,
        )
      if (values.some((value) => Adoption.parse(value.receipt)))
        throw new Error("Native target cannot mix fresh-copy and existing adoption")
      return Native.withPublication(
        values.map((value) => Native.Receipt.parse(value.receipt)),
        signal,
        body,
      )
    },
    assertPublication(value) {
      if (value.version === 2) {
        Download.assertPublication(value)
        return value
      }
      const adoption = Adoption.parse(value.receipt)
      if (adoption) {
        Adoption.assertPublication(Adoption.selection(value))
        return value
      }
      const receipt = Native.assertPublication(Native.Receipt.parse(value.receipt))
      if (
        value.workspaceID !== receipt.workspaceID ||
        value.scopeID !== receipt.scopeID ||
        value.path !== receipt.directory ||
        value.physicalID !== receipt.physicalID ||
        value.hostID !== receipt.hostID
      )
        throw new Error("Workspace publication has another native location")
      return value
    },
    async publish(value) {
      if (value.version === 2) return Download.publishFact(value)
      const adoption = Adoption.parse(value.receipt)
      if (adoption) await Adoption.publishFact(Adoption.selection(value))
    },
  })
}
