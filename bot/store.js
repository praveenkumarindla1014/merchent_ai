/**
 * In-memory context store.
 * Manages all 4 context types + conversation state + suppression keys.
 */

// (scope, context_id) → { version, payload }
const contexts = new Map();

// conversation_id → { turns: [...], merchant_id, customer_id, trigger_id, ended, auto_reply_count, sent_bodies: Set }
const conversations = new Map();

// suppression_key → timestamp (when it was suppressed)
const suppressions = new Set();

// ─── Context CRUD ──────────────────────────────────────────────────────────

export function getContext(scope, contextId) {
  return contexts.get(`${scope}:${contextId}`);
}

export function setContext(scope, contextId, version, payload) {
  const key = `${scope}:${contextId}`;
  const existing = contexts.get(key);
  if (existing && existing.version >= version) {
    return { accepted: false, reason: "stale_version", current_version: existing.version };
  }
  contexts.set(key, { version, payload });
  return { accepted: true };
}

export function getContextCounts() {
  const counts = { category: 0, merchant: 0, customer: 0, trigger: 0 };
  for (const [key] of contexts) {
    const scope = key.split(":")[0];
    if (counts[scope] !== undefined) counts[scope]++;
  }
  return counts;
}

// ─── Typed getters ─────────────────────────────────────────────────────────

export function getCategory(slug) {
  return contexts.get(`category:${slug}`)?.payload || null;
}

export function getMerchant(merchantId) {
  return contexts.get(`merchant:${merchantId}`)?.payload || null;
}

export function getCustomer(customerId) {
  return contexts.get(`customer:${customerId}`)?.payload || null;
}

export function getTrigger(triggerId) {
  return contexts.get(`trigger:${triggerId}`)?.payload || null;
}

export function getAllMerchants() {
  const merchants = [];
  for (const [key, val] of contexts) {
    if (key.startsWith("merchant:")) merchants.push(val.payload);
  }
  return merchants;
}

// ─── Conversation state ────────────────────────────────────────────────────

export function getConversation(convId) {
  return conversations.get(convId) || null;
}

export function createConversation(convId, { merchantId, customerId, triggerId }) {
  const conv = {
    id: convId,
    merchant_id: merchantId,
    customer_id: customerId,
    trigger_id: triggerId,
    turns: [],
    ended: false,
    auto_reply_count: 0,
    sent_bodies: new Set(),
  };
  conversations.set(convId, conv);
  return conv;
}

export function addTurn(convId, from, body) {
  const conv = conversations.get(convId);
  if (!conv) return;
  conv.turns.push({ from, body, ts: new Date().toISOString() });
}

export function endConversation(convId) {
  const conv = conversations.get(convId);
  if (conv) conv.ended = true;
}

export function isConversationEnded(convId) {
  return conversations.get(convId)?.ended || false;
}

export function getActiveConversationsForMerchant(merchantId) {
  const active = [];
  for (const [, conv] of conversations) {
    if (conv.merchant_id === merchantId && !conv.ended) active.push(conv);
  }
  return active;
}

// ─── Suppression ───────────────────────────────────────────────────────────

export function isSuppressed(key) {
  return suppressions.has(key);
}

export function addSuppression(key) {
  suppressions.add(key);
}

// ─── Body dedup check ──────────────────────────────────────────────────────

export function isBodyDuplicate(convId, body) {
  const conv = conversations.get(convId);
  if (!conv) return false;
  return conv.sent_bodies.has(body);
}

export function recordSentBody(convId, body) {
  const conv = conversations.get(convId);
  if (conv) conv.sent_bodies.add(body);
}
