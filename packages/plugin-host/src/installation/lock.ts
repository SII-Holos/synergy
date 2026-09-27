import path from "node:path"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"

export function withInstallationLock<T>(root: string, operation: () => Promise<T>) {
  return withFileLock({ directory: path.join(root, "state", ".locks"), key: "synergy-installation" }, operation)
}
