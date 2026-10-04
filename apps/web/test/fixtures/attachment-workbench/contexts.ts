import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

export const { use: useFile } = createSimpleContext({ name: "File", init: () => ({}) })
export const useSDK = () => ({ url: location.origin, client: createSynergyClient({ baseUrl: location.origin }) })
export const usePlatform = () => ({ fetch, openLink: () => {} })
export const useWorkbenchPanels = () => ({ openPanel: async () => {} })
