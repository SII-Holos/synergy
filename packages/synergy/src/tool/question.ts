import z from "zod"
import { Tool } from "./tool"
import { Question, DEFAULT_TIMEOUT } from "../question"
import { Config } from "../config/config"
import DESCRIPTION from "./question.txt"

interface QuestionMetadata {
  answers: Question.Answer[]
  timedOut: boolean
  timeout?: number
  createdAt?: number
}

const parameters = z.object({
  questions: z.array(Question.Info).describe("Questions to ask"),
})

export const QuestionTool = Tool.define<typeof parameters, QuestionMetadata>("question", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const cfg = await Config.get()
    const configuredTimeout = cfg.question?.timeout
    const timeout = configuredTimeout === 0 ? undefined : (configuredTimeout ?? DEFAULT_TIMEOUT)
    const createdAt = Date.now()

    ctx.metadata({ metadata: { answers: [], timedOut: false, timeout, createdAt } })

    let answers: Question.Answer[]
    let timedOut = false

    try {
      answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: params.questions,
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })
    } catch (e) {
      if (e instanceof Question.TimeoutError) {
        timedOut = true
        answers = []
      } else {
        throw e
      }
    }

    if (timedOut) {
      return {
        title: "Question timed out",
        output:
          "The user did not respond within the timeout period. They may be busy or away from the keyboard. Use your best judgment to proceed — you may continue without user input, use a sensible default, or skip the step that required this answer.",
        metadata: { answers, timedOut, timeout, createdAt },
      }
    }

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: { answers, timedOut, timeout, createdAt },
    }
  },
})
