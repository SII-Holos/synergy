import { RuntimeContext } from "./context"
import { HomeOwnershipFile } from "./home-ownership-file"

export namespace HomeOwnership {
  export const Info = HomeOwnershipFile.Info
  export type Info = HomeOwnershipFile.Info
  export const Error = HomeOwnershipFile.Error
  export type Error = HomeOwnershipFile.Error
  const state = RuntimeContext.state(() => ({ selected: undefined as Info | undefined }))

  function files() {
    const { host } = RuntimeContext.current()
    return HomeOwnershipFile.open({ root: host.root, env: host.env, selected: state().selected })
  }

  export function select(input: Omit<Info, "schemaVersion">) {
    RuntimeContext.assertCompositionOpen("Home owner")
    if (state().selected) throw new Error("Home owner is already selected")
    state().selected = Info.parse({ ...input, schemaVersion: 1 })
  }

  export async function read() {
    return files().read()
  }

  export async function assert(options: { required?: boolean } = {}) {
    return files().assert(options)
  }

  export async function persist() {
    return files().persist()
  }
}
