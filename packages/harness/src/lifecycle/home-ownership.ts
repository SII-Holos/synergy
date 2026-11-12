import { RuntimeContext } from "./context"
import { HomeOwnershipFile } from "./home-ownership-file"
import { z } from "zod"

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

  export function select(
    input:
      | Omit<z.infer<typeof HomeOwnershipFile.LegacyInfo>, "schemaVersion">
      | Omit<z.infer<typeof HomeOwnershipFile.FencedInfo>, "schemaVersion">
      | Omit<HomeOwnershipFile.RestorationInfo, "schemaVersion">,
  ) {
    RuntimeContext.assertCompositionOpen("Home owner")
    if (state().selected) throw new Error("Home owner is already selected")
    state().selected = Info.parse({
      ...input,
      schemaVersion: "installationID" in input ? 3 : "readerContract" in input ? 2 : 1,
    })
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
