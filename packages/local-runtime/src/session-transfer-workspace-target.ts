import { SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { NativeWorkspacePortableTarget as Native } from "./workspace/portable-target"

export function registerSessionTransferWorkspaceTarget() {
  Files.registerTargetHost({
    async prepare({ handoffID, captured, store, signal }) {
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
      await Native.validate(Native.Receipt.parse(value.receipt), signal)
    },
    withPublication(values, signal, body) {
      return Native.withPublication(
        values.map((value) => Native.Receipt.parse(value.receipt)),
        signal,
        body,
      )
    },
    assertPublication(value) {
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
  })
}
