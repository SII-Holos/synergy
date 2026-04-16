import type { DictionaryKey } from "./locale"

export interface RecallProviderPreset {
  id: string
  nameKey: DictionaryKey
  descKey: DictionaryKey
  keysUrl: string
  embedding: { baseURL: string; model: string }
  rerank: { baseURL: string; model: string }
}

export const RECALL_PROVIDERS: RecallProviderPreset[] = [
  {
    id: "siliconflow",
    nameKey: "recallProviderSiliconFlow",
    descKey: "recallProviderSiliconFlowDesc",
    keysUrl: "https://cloud.siliconflow.cn/account/ak",
    embedding: { baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" },
    rerank: { baseURL: "https://api.siliconflow.cn/v1", model: "BAAI/bge-reranker-v2-m3" },
  },
  {
    id: "jina",
    nameKey: "recallProviderJina",
    descKey: "recallProviderJinaDesc",
    keysUrl: "https://jina.ai/api-dashboard/",
    embedding: { baseURL: "https://api.jina.ai/v1", model: "jina-embeddings-v3" },
    rerank: { baseURL: "https://api.jina.ai/v1", model: "jina-reranker-v2-base-multilingual" },
  },
  {
    id: "voyage",
    nameKey: "recallProviderVoyage",
    descKey: "recallProviderVoyageDesc",
    keysUrl: "https://dashboard.voyageai.com/organization/api-keys",
    embedding: { baseURL: "https://api.voyageai.com/v1", model: "voyage-3-lite" },
    rerank: { baseURL: "https://api.voyageai.com/v1", model: "rerank-2.5-lite" },
  },
  {
    id: "cohere",
    nameKey: "recallProviderCohere",
    descKey: "recallProviderCohereDesc",
    keysUrl: "https://dashboard.cohere.com/api-keys",
    embedding: { baseURL: "https://api.cohere.ai/compatibility/v1", model: "embed-multilingual-v3.0" },
    rerank: { baseURL: "https://api.cohere.com/v2", model: "rerank-v3.5" },
  },
]
