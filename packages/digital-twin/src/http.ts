import { Hono } from "hono"
import { z } from "zod"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { RuntimeShuttingDownError } from "@ericsanchezok/synergy-server/server/error"
import { DigitalTwinContract } from "./contract"
import { DigitalTwin } from "./service"
import { PredictionError } from "./inference"

export function DigitalTwinRoute() {
  return new Hono().post(
    "/predict-next-input",
    describeRoute({
      summary: "Predict the next user input",
      operationId: "digitalTwin.predictNextInput",
      responses: {
        200: {
          description: "One editable prediction or abstention",
          content: { "application/json": { schema: resolver(DigitalTwinContract.Result) } },
        },
        ...Object.fromEntries(
          [409, 408, 502, 503].map((status) => [
            status,
            {
              description: "Prediction unavailable",
              content: {
                "application/json": {
                  schema: resolver(
                    status === 503
                      ? z.union([DigitalTwinContract.Failure, RuntimeShuttingDownError])
                      : DigitalTwinContract.Failure,
                  ),
                },
              },
            },
          ]),
        ),
      },
    }),
    validator("json", DigitalTwinContract.Input),
    async (c) => {
      try {
        return c.json(await DigitalTwin.predictNextInput({ ...c.req.valid("json"), signal: c.req.raw.signal }))
      } catch (error) {
        if (!(error instanceof PredictionError)) throw error
        const status =
          error.code === "cancelled"
            ? 408
            : error.code === "model_unavailable"
              ? 503
              : error.code === "invalid_prediction"
                ? 502
                : 409
        return c.json({ code: error.code, message: error.message }, status)
      }
    },
  )
}
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["digital-twin"],
      routes: { "scoped-before-assets": new Hono().route("/digital-twin", DigitalTwinRoute()) },
    },
    "digital-twin",
  )
}
