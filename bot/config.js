// =============================================================================
// CONFIGURATION — Edit this section
// =============================================================================

// LLM Provider: "openai", "anthropic", "gemini", "deepseek", "groq", "openrouter"
export const LLM_PROVIDER = process.env.LLM_PROVIDER || "gemini";

// API Key
export const LLM_API_KEY = process.env.LLM_API_KEY || "";

// Model (leave empty for provider default)
export const LLM_MODEL = process.env.LLM_MODEL || "";

// Server port
export const PORT = parseInt(process.env.PORT || "8080", 10);

// Team metadata
export const TEAM = {
  team_name: process.env.TEAM_NAME || "Solo Challenger",
  team_members: (process.env.TEAM_MEMBERS || "Praveen").split(","),
  model: LLM_MODEL || getDefaultModel(),
  approach: "4-context LLM composer with trigger-kind dispatch, auto-reply detection, intent-transition routing, and multi-turn conversation state",
  contact_email: process.env.CONTACT_EMAIL || "praveen@example.com",
  version: "1.0.0",
  submitted_at: new Date().toISOString(),
};

// Dataset directory (seed data)
export const DATASET_DIR = process.env.DATASET_DIR || "../dataset";

function getDefaultModel() {
  const defaults = {
    openai: "gpt-4o",
    anthropic: "claude-sonnet-4-20250514",
    gemini: "gemini-2.0-flash",
    deepseek: "deepseek-chat",
    groq: "llama-3.1-70b-versatile",
    openrouter: "anthropic/claude-3-haiku",
  };
  return defaults[LLM_PROVIDER] || "gpt-4o";
}
