import z from "zod"
import { Tool } from "./tool"
import { AgoraClient } from "../agora"
import DESCRIPTION from "./agora-comment.txt"

const parameters = z
  .object({
    post_id: z.string().describe("The project's post ID"),
    content: z.string().describe("The comment text"),
    parent_type: z
      .enum(["post", "answer", "comment"])
      .default("post")
      .describe("What to attach the comment to. Defaults to 'post'. Use 'answer' or 'comment' for threaded replies."),
    parent_id: z
      .string()
      .optional()
      .describe(
        "ID of the parent object. Required when parent_type is 'answer' or 'comment'. Defaults to post_id when parent_type is 'post'.",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.parent_type !== "post" && !data.parent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent_id"],
        message: `parent_id is required when parent_type is '${data.parent_type}'`,
      })
    }
  })

interface CommentResponse {
  id: string
}

interface AgoraCommentMetadata {
  postId: string
  commentId: string
}

export const AgoraCommentTool = Tool.define<typeof parameters, AgoraCommentMetadata>("agora_comment", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const parentId = params.parent_id ?? params.post_id

    const response = await AgoraClient.request<CommentResponse>("POST", `/api/posts/${params.post_id}/comments`, {
      body: {
        parent_type: params.parent_type,
        parent_id: parentId,
        content: params.content,
      },
      abort: ctx.abort,
    })

    const output = [
      `Comment posted on ${params.parent_type} successfully.`,
      "",
      `Post ID: ${params.post_id}`,
      `Comment ID: ${response.id}`,
    ].join("\n")

    return {
      title: "Commented",
      output,
      metadata: {
        postId: params.post_id,
        commentId: response.id,
      },
    }
  },
})
