import { Hono } from "hono"
import type { WSContext } from "hono/ws"
import { upgradeWebSocket } from "hono/bun"
import { describeRoute } from "hono-openapi"
import { COMPUTER_MAX_MESSAGE_BYTES } from "@ericsanchezok/synergy-computer"
import { computerBroker, type ComputerBroker } from "../computer/broker"

export function createComputerRoute(broker: ComputerBroker = computerBroker) {
  return new Hono().get(
    "/computer/host/broker",
    describeRoute({
      operationId: "computer.host.broker",
      summary: "Connect the authenticated native Computer host",
      responses: { 101: { description: "Native host WebSocket" } },
    }),
    upgradeWebSocket((c) => {
      let socket: WSContext | undefined
      return {
        onOpen(_event, ws) {
          if (c.req.header("origin")) ws.close(1008, "Native hosts only")
        },
        onMessage(event, ws) {
          if (c.req.header("origin")) {
            ws.close(1008, "Native hosts only")
            return
          }
          const raw = String(event.data)
          if (Buffer.byteLength(raw) > COMPUTER_MAX_MESSAGE_BYTES) {
            ws.close(1009, "Computer message too large")
            return
          }
          try {
            const input: unknown = JSON.parse(raw)
            if (!socket) {
              broker.attach(ws, input)
              socket = ws
            } else broker.handle(socket, input)
          } catch {
            ws.close(1008, "Invalid Computer host message")
          }
        },
        onClose() {
          if (socket) broker.detach(socket)
        },
        onError() {
          if (socket) broker.detach(socket)
        },
      }
    }),
  )
}
export const ComputerRoute = createComputerRoute()
