/**
 * LLM Provider Abstraction
 * Supports: OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter
 * Uses native fetch (Node 24+)
 */

import { LLM_PROVIDER, LLM_API_KEY, LLM_MODEL } from "./config.js";

const DEFAULTS = {
  openai: { model: "gpt-4o", url: "https://api.openai.com/v1/chat/completions" },
  anthropic: { model: "claude-sonnet-4-20250514", url: "https://api.anthropic.com/v1/messages" },
  gemini: { model: "gemini-2.0-flash", url: "https://generativelanguage.googleapis.com/v1beta/models/" },
  deepseek: { model: "deepseek-chat", url: "https://api.deepseek.com/v1/chat/completions" },
  groq: { model: "llama-3.1-70b-versatile", url: "https://api.groq.com/openai/v1/chat/completions" },
  openrouter: { model: "anthropic/claude-3-haiku", url: "https://openrouter.ai/api/v1/chat/completions" },
};

const model = LLM_MODEL || DEFAULTS[LLM_PROVIDER]?.model || "gpt-4o";

/**
 * Call the configured LLM with a system prompt and user prompt.
 * Returns the text response.
 */
export async function llmComplete(userPrompt, systemPrompt = null, { temperature = 0.2, maxTokens = 2000 } = {}) {
  if (!LLM_API_KEY && LLM_PROVIDER !== "ollama") {
    // Fallback to rule-based composition if no API key
    return null;
  }

  try {
    if (LLM_PROVIDER === "anthropic") {
      return await callAnthropic(userPrompt, systemPrompt, temperature, maxTokens);
    } else if (LLM_PROVIDER === "gemini") {
      return await callGemini(userPrompt, systemPrompt, temperature, maxTokens);
    } else {
      // OpenAI-compatible: openai, deepseek, groq, openrouter
      return await callOpenAICompatible(userPrompt, systemPrompt, temperature, maxTokens);
    }
  } catch (err) {
    console.error(`[LLM] Error calling ${LLM_PROVIDER}:`, err.message);
    return null;
  }
}

async function callOpenAICompatible(userPrompt, systemPrompt, temperature, maxTokens) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const url = DEFAULTS[LLM_PROVIDER]?.url || DEFAULTS.openai.url;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LLM_API_KEY}`,
  };
  if (LLM_PROVIDER === "openrouter") {
    headers["HTTP-Referer"] = "https://magicpin.com";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(45000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(userPrompt, systemPrompt, temperature, maxTokens) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const resp = await fetch(DEFAULTS.anthropic.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || "";
}

async function callGemini(userPrompt, systemPrompt, temperature, maxTokens) {
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
  const url = `${DEFAULTS.gemini.url}${model}:generateContent?key=${LLM_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export function isLLMConfigured() {
  return !!LLM_API_KEY || LLM_PROVIDER === "ollama";
}
