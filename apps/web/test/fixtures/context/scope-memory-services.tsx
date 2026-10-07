const ok = <T,>(data: T) => Promise.resolve({ data })

export function createSynergyClient(options: { scopeID: string }) {
  return {
    scope: {
      bootstrapCore: () => ok({ scopeID: options.scopeID, provider: { all: [] }, agent: [], config: {} }),
    },
    permission: { list: () => ok([]) },
    question: { list: () => ok([]) },
    session: { list: () => ok({ total: 0, data: [] }), inbox: () => ok([]) },
  }
}

export const useGlobalSDK = () => ({
  capabilities: { load: async () => {}, has: () => false },
  prepareScopeState() {},
  connected: () => false,
  content: { active() {} },
  event: { listen: () => () => {} },
  url: "http://scope-memory.test/",
  client: {
    config: { global: () => ok({}) },
    global: { health: () => ok({ healthy: true }), paths: { get: () => ok({}) }, agenda: { list: () => ok([]) } },
    scope: { list: () => ok([]) },
    provider: { list: () => ok({ all: [] }), auth: () => ok({}) },
    session: { statuses: () => ok({}) },
  },
})

export const LocaleConfigReconciler = () => null
export const FatalErrorPage = () => <div>failure</div>
export const DialogSelectServer = () => null
export const useDialog = () => ({ show() {} })
export const showToast = () => {}
export const browserPerformanceEnabled = () => false
export const startBrowserPerformanceMetrics = () => {}
export const stopBrowserPerformanceMetrics = () => {}
export const browserTokenDurationSampleRate = () => 0.1
export const recordTokenApply = () => {}
