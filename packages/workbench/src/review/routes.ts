import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { ReviewSchema as R } from "./schema"
import { ReviewGit } from "./git"
import { ReviewState } from "./state"

const response = (schema: z.ZodType) => ({
  description: "Review result",
  content: { "application/json": { schema: resolver(schema) } },
})
const errors = { 400: response(R.Invalid.Schema), 409: response(R.Conflict.Schema) }
async function handle<T>(load: () => Promise<T>) {
  try {
    return Response.json(await load())
  } catch (error) {
    if (error instanceof R.Invalid) return Response.json(error.toObject(), { status: 400 })
    if (error instanceof R.Conflict) return Response.json(error.toObject(), { status: 409 })
    throw error
  }
}
export function ReviewRoutes() {
  return new Hono()
    .get(
      "/compare",
      describeRoute({
        summary: "Compare Git file versions without mutations",
        operationId: "review.compare",
        responses: { 200: response(R.Comparison), ...errors },
      }),
      validator("query", R.CompareInput),
      (c) => handle(() => ReviewGit.compare(c.req.valid("query"), c.req.raw.signal)),
    )
    .get(
      "/file",
      describeRoute({
        summary: "Read a version checked Git diff and its contents",
        operationId: "review.file",
        responses: { 200: response(R.Content), ...errors },
      }),
      validator("query", R.FileInput),
      (c) => handle(() => ReviewGit.file(c.req.valid("query"), c.req.raw.signal)),
    )
    .get(
      "/state/:sessionID",
      describeRoute({
        summary: "Read session review notes",
        operationId: "review.state.get",
        responses: { 200: response(ReviewState.Result), ...errors },
      }),
      validator("param", ReviewState.Input.pick({ sessionID: true })),
      (c) => handle(() => ReviewState.get(c.req.valid("param").sessionID)),
    )
    .put(
      "/state/:sessionID",
      describeRoute({
        summary: "Save session review notes with a revision check",
        operationId: "review.state.update",
        responses: { 200: response(ReviewState.Result), ...errors },
      }),
      validator("param", ReviewState.Input.pick({ sessionID: true })),
      validator("json", ReviewState.Input.omit({ sessionID: true })),
      (c) => handle(() => ReviewState.update({ sessionID: c.req.valid("param").sessionID, ...c.req.valid("json") })),
    )
}
