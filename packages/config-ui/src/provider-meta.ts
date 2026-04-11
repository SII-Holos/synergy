export interface ProviderMeta {
  keysUrl: string
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: { keysUrl: "https://platform.claude.com/settings/keys" },
  openai: { keysUrl: "https://platform.openai.com/api-keys" },
  google: { keysUrl: "https://aistudio.google.com/apikey" },
  openrouter: { keysUrl: "https://openrouter.ai/keys" },
  xai: { keysUrl: "https://console.x.ai/api-keys" },
  groq: { keysUrl: "https://console.groq.com/keys" },
  mistral: { keysUrl: "https://console.mistral.ai/api-keys/" },
  deepseek: { keysUrl: "https://platform.deepseek.com/api_keys" },
  siliconflow: { keysUrl: "https://cloud.siliconflow.cn/account/ak" },
  "siliconflow-cn": { keysUrl: "https://cloud.siliconflow.cn/account/ak" },
  "github-copilot": { keysUrl: "https://github.com/settings/tokens" },
  "github-models": { keysUrl: "https://github.com/settings/tokens" },
  zhipuai: { keysUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  "moonshotai-cn": { keysUrl: "https://platform.moonshot.cn/console/api-keys" },
}
