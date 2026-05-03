# Vera Challenge Bot

## Approach

**Architecture**: Node.js + Express server with a 4-context LLM composer and rule-based fallback.

### How it works

1. **Context Store** (`store.js`): In-memory store for all 4 context types (category, merchant, customer, trigger) with versioned idempotent updates, conversation state tracking, suppression dedup, and body repetition detection.

2. **Composer** (`composer.js`): Two-tier composition:
   - **LLM-powered** (when API key configured): Builds a structured prompt from all 4 contexts with trigger-kind-specific framing. Parses JSON output.
   - **Rule-based fallback**: 20+ trigger-kind-specific composers that pull real data from contexts. No fabrication — every number comes from the payload.

3. **Conversation Handler** (in `composer.js`): Multi-turn reply logic with:
   - **Auto-reply detection**: Pattern-matching against common WhatsApp Business canned replies. Escalates: first hit → gentle nudge, second → 24h wait, third → end.
   - **Intent transition**: Detects commitment phrases ("yes", "let's do it", "haan") and switches to action mode immediately.
   - **Hostile handling**: Detects opt-out/abuse and exits gracefully.
   - **Off-topic routing**: Politely declines and redirects to original thread.

### Key design decisions

- **Rule-based fallback is production-grade**: Even without an LLM API key, the bot produces specific, category-correct messages using data from contexts. This ensures zero downtime and consistent quality.
- **No fabrication**: Every number, date, and source citation comes from the context payloads. The rule-based composers never invent data.
- **Hindi-English code-mix**: Customer-facing messages check `language_pref` and switch to Hindi-English naturally (e.g., "Aapki cleaning due hai").
- **Single CTA per message**: No multi-choice except for booking flows (slot selection).
- **Suppression**: Each trigger's `suppression_key` is tracked to prevent re-sends.

### What additional context would have helped

1. **Real merchant conversation transcripts** — more examples of how Indian merchants actually reply (beyond the 4 patterns shown) would improve auto-reply detection and intent routing.
2. **Category-specific offer catalogs** with actual conversion rates — knowing which offer formats work best per vertical would sharpen the rule-based composers.
3. **Merchant schedule/availability data** — for customer-facing messages, real slot availability would make booking flows more concrete.

## Setup

```bash
cd bot
npm install

# Set your LLM API key (optional — bot works without it via rule-based fallback)
# Supported: openai, anthropic, gemini, deepseek, groq, openrouter
export LLM_PROVIDER=gemini
export LLM_API_KEY=your_key_here

# Start
node server.js
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/healthz` | Liveness + context counts |
| GET | `/v1/metadata` | Team info |
| POST | `/v1/context` | Receive context push |
| POST | `/v1/tick` | Periodic wake-up; compose proactive messages |
| POST | `/v1/reply` | Handle merchant/customer replies |

## Testing

```bash
# Point judge simulator at this bot
export BOT_URL=http://localhost:8080
python judge_simulator.py
```
