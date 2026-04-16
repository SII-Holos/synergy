import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import type { RoleKey } from "./store"

export const ROLE_META: Array<{
  key: RoleKey
  icon: IconName
  labelKey: `role_${RoleKey}`
  headlineKey: `role_${RoleKey}_headline`
  descriptionKey: `role_${RoleKey}_desc`
}> = [
  {
    key: "nano_model",
    icon: "zap",
    labelKey: "role_nano_model",
    headlineKey: "role_nano_model_headline",
    descriptionKey: "role_nano_model_desc",
  },
  {
    key: "mini_model",
    icon: "zap",
    labelKey: "role_mini_model",
    headlineKey: "role_mini_model_headline",
    descriptionKey: "role_mini_model_desc",
  },
  {
    key: "mid_model",
    icon: "code",
    labelKey: "role_mid_model",
    headlineKey: "role_mid_model_headline",
    descriptionKey: "role_mid_model_desc",
  },
  {
    key: "thinking_model",
    icon: "brain",
    labelKey: "role_thinking_model",
    headlineKey: "role_thinking_model_headline",
    descriptionKey: "role_thinking_model_desc",
  },
  {
    key: "long_context_model",
    icon: "file-text",
    labelKey: "role_long_context_model",
    headlineKey: "role_long_context_model_headline",
    descriptionKey: "role_long_context_model_desc",
  },
  {
    key: "creative_model",
    icon: "sparkles",
    labelKey: "role_creative_model",
    headlineKey: "role_creative_model_headline",
    descriptionKey: "role_creative_model_desc",
  },
  {
    key: "holos_friend_reply_model",
    icon: "message-circle",
    labelKey: "role_holos_friend_reply_model",
    headlineKey: "role_holos_friend_reply_model_headline",
    descriptionKey: "role_holos_friend_reply_model_desc",
  },
]
