import type { AiConfig, AiProvider } from "../../domain/types";

export const defaultAiConfig: AiConfig = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  interventionMode: "smart",
};

export const providerPresets: Record<AiProvider, { label: string; baseUrl: string; model: string; keyRequired: boolean }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyRequired: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyRequired: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyRequired: true },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", keyRequired: false },
  custom: { label: "Custom endpoint", baseUrl: "", model: "", keyRequired: true },
};
