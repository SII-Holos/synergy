import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { Vcs } from "../project/vcs"
import { errors } from "./error"

export const GitRoute = new Hono().post(
  "/init",
  describeRoute({
    summary: "Initialize git repository",
    description: "Initialize a git repository in the specified directory if one does not already exist.",
    operationId: "git.init",
    responses: {
      200: {
        description: "Git initialization result",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                initialized: z.boolean().meta({ description: "Whether a new git repository was initialized" }),
              }),
            ),
          },
        },
      },
      ...errors(400),
    },
  }),
  validator(
    "json",
    z.object({
      directory: z.string().meta({ description: "Directory path to initialize git in" }),
    }),
  ),
  async (c) => {
    const { directory } = c.req.valid("json")
    const initialized = await Vcs.initIfNeeded(directory)
    return c.json({ initialized })
  },
)
