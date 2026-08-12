import { describe, expect, test } from "bun:test"
import {
  renderFeishuQuestionCard,
  parseFeishuQuestionCardAction,
  sendFeishuQuestionCard,
  renderFeishuQuestionCardSummary,
  renderFeishuQuestionCardSummarySafe,
} from "../../src/channel/provider/feishu"
import type { Question } from "../../src/question"

const singleQuestions: Question.Info[] = [
  {
    question: "Which environment?",
    header: "Env",
    options: [
      { label: "Staging", description: "Staging server" },
      { label: "Production", description: "Production server" },
    ],
  },
]

const mixedQuestions: Question.Info[] = [
  {
    question: "Which environment?",
    header: "Env",
    options: [
      { label: "Staging", description: "Staging server" },
      { label: "Production", description: "Production server" },
    ],
  },
  {
    question: "Select features to deploy",
    header: "Features",
    options: [
      { label: "Feature A", description: "New feature A" },
      { label: "Feature B", description: "New feature B" },
      { label: "Feature C", description: "New feature C" },
    ],
    multiple: true,
  },
]

describe("Feishu question card rendering", () => {
  test("produces a schema 2.0 form with bounded controls, opaque option indices, and a submit marker", () => {
    const requestId = "que_abc123"
    const rendered = renderFeishuQuestionCard(mixedQuestions, requestId)

    expect(rendered.schema).toBe("2.0")
    expect(rendered.config?.update_multi).toBe(true)
    expect(typeof rendered.config?.summary?.content).toBe("string")

    const form = rendered.body.elements[0] as {
      tag: string
      name: string
      elements: Array<Record<string, any>>
    }
    expect(form.tag).toBe("form")
    expect(form.name).toBe("question_form")
    expect(form.elements).toHaveLength(7)

    const q0 = form.elements[1]
    expect(q0.tag).toBe("select_static")
    expect(q0.name).toBe("question_0")
    expect(q0.element_id).toBe("q0")
    expect(q0.options).toEqual([
      { text: { tag: "plain_text", content: "Staging" }, value: "0" },
      { text: { tag: "plain_text", content: "Production" }, value: "1" },
    ])

    const custom0 = form.elements[2]
    expect(custom0.tag).toBe("input")
    expect(custom0.name).toBe("question_0_custom")
    expect(custom0.element_id).toBe("o0")
    expect(custom0.max_length).toBe(1_000)

    const q1 = form.elements[4]
    expect(q1.tag).toBe("multi_select_static")
    expect(q1.name).toBe("question_1")
    expect(q1.element_id).toBe("q1")
    expect(q1.options.map((option: { value: string }) => option.value)).toEqual(["0", "1", "2"])

    const submit = form.elements[6]
    expect(submit).toMatchObject({
      tag: "button",
      type: "primary",
      form_action_type: "submit",
      behaviors: [
        {
          type: "callback",
          value: {
            synergy_question_card: {
              version: 1,
              request_id: requestId,
            },
          },
        },
      ],
    })
  })

  test("keeps generated form names and element IDs unique and bounded", () => {
    const manyQuestions: Question.Info[] = Array.from({ length: 5 }, (_, i) => ({
      question: `Question ${i}?`,
      header: `Q${i}`,
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
    }))
    const rendered = renderFeishuQuestionCard(manyQuestions, "que_many")
    const form = rendered.body.elements[0] as { elements: Array<Record<string, any>> }
    const controls = form.elements.filter((element) => element.name?.startsWith("question_"))

    expect(controls).toHaveLength(10)
    expect(new Set(controls.map((element) => element.name)).size).toBe(10)
    expect(new Set(controls.map((element) => element.element_id)).size).toBe(10)
    for (const element of controls) {
      expect(element.name.length).toBeLessThanOrEqual(32)
      expect(element.element_id.length).toBeLessThanOrEqual(32)
    }
  })
})

describe("Feishu question card callback parsing", () => {
  const validFormCallback = {
    schema: "2.0",
    header: { event_id: "evt_callback_001", event_type: "card.action.trigger" },
    event: {
      context: { open_message_id: "om_question_card", open_chat_id: "oc_chat" },
      operator: { open_id: "ou_requester" },
      action: {
        tag: "button",
        value: {
          synergy_question_card: {
            version: 1,
            request_id: "que_abc123",
          },
        },
        form_value: {
          question_0: "0",
          question_0_custom: "custom staging",
          question_1: ["0", "2"],
        },
      },
    },
  }

  test("extracts a valid form callback with requestId, account/chat/requester/message, and formValues", () => {
    const parsed = parseFeishuQuestionCardAction(validFormCallback)
    expect(parsed.status).toBe("valid")
    if (parsed.status !== "valid") return

    expect(parsed.callback.requestId).toBe("que_abc123")
    expect(parsed.callback.messageId).toBe("om_question_card")
    expect(parsed.callback.chatId).toBe("oc_chat")
    expect(parsed.callback.requesterId).toBe("ou_requester")
    expect(parsed.callback.eventId).toBeTruthy()

    expect(parsed.callback.formValues).toHaveLength(2)

    // Question 0: single select, value "0" mapped to selected ["0"], custom text present
    const fv0 = parsed.callback.formValues[0]
    expect(fv0.name).toBe("question_0")
    expect(fv0.selected).toEqual(["0"])
    expect(fv0.custom).toBe("custom staging")

    // Question 1: multi select, values ["0", "2"]
    const fv1 = parsed.callback.formValues[1]
    expect(fv1.name).toBe("question_1")
    expect(fv1.selected).toEqual(["0", "2"])
    expect(fv1.custom).toBeUndefined()
  })

  test("preserves a custom-only answer when Feishu omits the unselected select field", () => {
    const parsed = parseFeishuQuestionCardAction({
      schema: "2.0",
      header: { event_id: "evt_custom_only", event_type: "card.action.trigger" },
      event: {
        context: { open_message_id: "om_question_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_requester" },
        action: {
          tag: "button",
          value: {
            synergy_question_card: {
              version: 1,
              request_id: "que_custom_only",
            },
          },
          form_value: {
            question_0_custom: "A custom environment",
          },
        },
      },
    })

    expect(parsed).toEqual({
      status: "valid",
      callback: {
        eventId: "evt_custom_only",
        requestId: "que_custom_only",
        messageId: "om_question_card",
        chatId: "oc_chat",
        requesterId: "ou_requester",
        formValues: [{ name: "question_0", selected: [], custom: "A custom environment" }],
      },
    })
  })

  test("routes the synergy_question_card namespace distinctly from response_card/plugin callbacks", () => {
    // Non-question-card payloads should be ignored
    expect(parseFeishuQuestionCardAction({ action: { tag: "button", value: { other: true } } })).toEqual({
      status: "ignored",
    })

    // Response card namespace should be ignored by question card parser
    expect(
      parseFeishuQuestionCardAction({
        action: {
          tag: "button",
          value: {
            synergy_response_card: {
              version: 1,
              request_id: "req_1",
              action_id: "response_card:test",
              action_type: "button",
              value: "x",
            },
          },
        },
      }),
    ).toEqual({ status: "ignored" })

    // Plugin-type callbacks remain ignored
    expect(
      parseFeishuQuestionCardAction({
        action: { tag: "button", value: { plugin_action: "deploy" } },
      }),
    ).toEqual({ status: "ignored" })
  })

  test("rejects malformed question card callbacks", () => {
    // Missing action.form_value
    expect(
      parseFeishuQuestionCardAction({
        context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_requester" },
        action: {
          tag: "button",
          value: {
            synergy_question_card: { version: 1, request_id: "que_abc" },
          },
        },
      }),
    ).toEqual({ status: "invalid" })

    // Wrong version
    expect(
      parseFeishuQuestionCardAction({
        context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_requester" },
        action: {
          tag: "button",
          value: {
            synergy_question_card: { version: 2, request_id: "que_abc" },
          },
          form_value: { question_0: "0" },
        },
      }),
    ).toEqual({ status: "invalid" })

    // Missing operator
    expect(
      parseFeishuQuestionCardAction({
        context: { open_message_id: "om_card" },
        action: {
          tag: "button",
          value: {
            synergy_question_card: { version: 1, request_id: "que_abc" },
          },
          form_value: { question_0: "0" },
        },
      }),
    ).toEqual({ status: "invalid" })

    // The form container is not the triggering component in CardKit callbacks.
    expect(
      parseFeishuQuestionCardAction({
        context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_requester" },
        action: {
          tag: "form",
          value: { synergy_question_card: { version: 1, request_id: "que_abc" } },
          form_value: { question_0: "0" },
        },
      }),
    ).toEqual({ status: "invalid" })
  })
})

describe("Feishu question card size validation", () => {
  test("rejects oversized card before any token or fetch call", async () => {
    const manyQuestions: Question.Info[] = Array.from({ length: 60 }, (_, i) => ({
      question: `Question number ${i} with padded text for size?`,
      header: `Q${i}`,
      options: Array.from({ length: 8 }, (_, j) => ({
        label: `Option ${i}-${j} with extra padding label`,
        description: `A very long description for option ${i}-${j} that adds significant byte weight to push past the 30KiB limit`,
      })),
      multiple: i % 2 === 0,
    }))

    const rendered = renderFeishuQuestionCard(manyQuestions, "que_oversized")
    const byteLength = new TextEncoder().encode(JSON.stringify(rendered)).length
    expect(byteLength).toBeGreaterThan(30_000)

    const originalFetch = globalThis.fetch
    const fetchCalls: unknown[] = []
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args)
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card_123" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await expect(
        sendFeishuQuestionCard({
          apiBase: "https://open.feishu.test/open-apis",
          getAccessToken: async () => "token_test",
          chatId: "oc_chat",
          requestId: "que_oversized",
          questions: manyQuestions,
        }),
      ).rejects.toThrow(/too large|exceed|size|limit/i)

      expect(fetchCalls).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("Feishu question card summary", () => {
  test("renders a read-only summary with each question and its submitted answers", () => {
    const rendered = renderFeishuQuestionCardSummary(mixedQuestions, [["Staging"], ["Feature A", "Feature C"]])

    expect(rendered.schema).toBe("2.0")
    expect(rendered.header.title.content).toBe("回答已提交")
    expect(rendered.config?.summary?.content).toBe("回答已提交")

    const elements = rendered.body.elements as Array<Record<string, unknown>>
    expect(elements.some((element) => element.tag === "form")).toBe(false)
    expect(elements.every((element) => element.tag === "markdown")).toBe(true)

    const content = elements.map((element) => String(element.content)).join("\n")
    expect(content).toContain("Env")
    expect(content).toContain("Which environment?")
    expect(content).toContain("Staging")
    expect(content).toContain("Select features to deploy")
    expect(content).toContain("Feature A")
    expect(content).toContain("Feature C")
    expect(content).not.toContain("question_form")
  })

  test("bounded provider renderer returns a schema-valid summary", () => {
    const rendered = renderFeishuQuestionCardSummarySafe(singleQuestions, [["Production"]])

    expect(rendered).toBeDefined()
    const card = rendered as { header: { title: { content: string } }; body: { elements: Array<{ tag: string }> } }
    expect(card.header.title.content).toBe("回答已提交")
    expect(card.body.elements.every((element) => element.tag === "markdown")).toBe(true)
  })

  test("bounded provider renderer returns undefined for an oversized summary", () => {
    const manyQuestions: Question.Info[] = Array.from({ length: 60 }, (_, i) => ({
      question: `Question number ${i} with padded text for size?`,
      header: `Q${i}`,
      options: Array.from({ length: 8 }, (_, j) => ({
        label: `Option ${i}-${j} with extra padding label`,
        description: `A very long description for option ${i}-${j} that adds significant byte weight to push past the 30KiB limit`,
      })),
      multiple: i % 2 === 0,
    }))

    expect(
      renderFeishuQuestionCardSummarySafe(
        manyQuestions,
        manyQuestions.map(() => [`自定义长答案${"很长的用户自定义输入内容".repeat(60)}`]),
      ),
    ).toBeUndefined()
  })
})
