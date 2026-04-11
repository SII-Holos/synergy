import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { produce } from "solid-js/store"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

type SessionWithAllowAll = Session & { allowAll?: boolean }

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    const routeDirectory = () => (params.dir ? base64Decode(params.dir) : undefined)

    function isAllowingAll(sessionID: string, directory = routeDirectory()) {
      if (!directory) return false
      const [store] = globalSync.child(directory)
      const result = Binary.search(store.session, sessionID, (session) => session.id)
      if (!result.found) return false
      return (store.session[result.index] as SessionWithAllowAll).allowAll ?? false
    }

    function setAllowAll(sessionID: string, enabled: boolean, directory = routeDirectory()) {
      if (!directory) return false
      const [, setStore] = globalSync.child(directory)
      let updated = false
      setStore(
        produce((draft) => {
          const result = Binary.search(draft.session, sessionID, (session) => session.id)
          if (!result.found) return
          ;(draft.session[result.index] as SessionWithAllowAll).allowAll = enabled
          updated = true
        }),
      )
      return updated
    }

    return {
      isAllowingAll,
      async toggleAllowAll(sessionID: string, directory: string) {
        const previous = isAllowingAll(sessionID, directory)
        const enabling = !previous
        const updated = setAllowAll(sessionID, enabling, directory)
        return globalSDK.client.permission.setAllowAll({ sessionID, enabled: enabling, directory }).catch(() => {
          if (updated) setAllowAll(sessionID, previous, directory)
        })
      },
      permissionsEnabled: () => !!params.dir,
    }
  },
})
