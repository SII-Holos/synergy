import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSync } from "@/context/global-sync"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

type SessionWithAllowAll = Session & { allowAll?: boolean }

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSync = useGlobalSync()

    const routeDirectory = () => (params.dir ? base64Decode(params.dir) : undefined)

    function isAllowingAll(sessionID: string, directory = routeDirectory()) {
      if (!directory) return false
      const [store] = globalSync.child(directory)
      const result = Binary.search(store.session, sessionID, (session) => session.id)
      if (!result.found) return false
      return (store.session[result.index] as SessionWithAllowAll).allowAll ?? false
    }

    return {
      isAllowingAll,
    }
  },
})
