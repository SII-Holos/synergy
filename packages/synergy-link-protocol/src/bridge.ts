export namespace SynergyLinkBridge {
  export const REQUEST_EVENT = "synergy_link.execution.request"
  export const RESPONSE_EVENT = "synergy_link.execution.response"

  export type RequestEvent = typeof REQUEST_EVENT
  export type ResponseEvent = typeof RESPONSE_EVENT
}
