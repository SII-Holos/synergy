export type FeishuMention = {
  key: string
  id: { open_id?: string; user_id?: string; union_id?: string }
  name: string
}

export type FeishuMessage = {
  chat_id?: string
  chat_type?: string
  message_type?: string
  content?: string
  mentions?: FeishuMention[]
  create_time?: string | number
  message_id?: string
  root_id?: string
  parent_id?: string
  thread_id?: string
}

export type FeishuSender = {
  sender_id?: {
    open_id?: string
    user_id?: string
    union_id?: string
  }
  sender_type?: string
}

export type FeishuEventPayload = {
  message?: FeishuMessage
  event?: {
    message?: FeishuMessage
    sender?: FeishuSender
  }
  sender?: FeishuSender
}
