/**
 * Vera Challenge Bot — Express Server
 * Exposes: POST /v1/context, POST /v1/tick, POST /v1/reply, GET /v1/healthz, GET /v1/metadata
 */

import express from "express";
import { PORT, TEAM } from "./config.js";
import {
  setContext, getContextCounts, getTrigger, getMerchant, getCustomer,
  getCategory, isSuppressed, addSuppression, createConversation,
  getConversation, addTurn, endConversation, isConversationEnded,
  isBodyDuplicate, recordSentBody, getActiveConversationsForMerchant,
} from "./store.js";
import { composeMessage, composeReply, detectAutoReply } from "./composer.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const START = Date.now();

// ─── Root — API info ───────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "Vera Merchant AI Assistant",
    status: "running",
    team: TEAM.team_name,
    endpoints: [
      "GET  /v1/healthz",
      "GET  /v1/metadata",
      "POST /v1/context",
      "POST /v1/tick",
      "POST /v1/reply",
    ],
  });
});

// ─── GET /v1/healthz ───────────────────────────────────────────────────────

app.get("/v1/healthz", (_req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - START) / 1000),
    contexts_loaded: getContextCounts(),
  });
});

// ─── GET /v1/metadata ──────────────────────────────────────────────────────

app.get("/v1/metadata", (_req, res) => {
  res.json(TEAM);
});

// ─── POST /v1/context ──────────────────────────────────────────────────────

app.post("/v1/context", (req, res) => {
  const { scope, context_id, version, payload, delivered_at } = req.body;

  if (!scope || !context_id || version === undefined || !payload) {
    return res.status(400).json({ accepted: false, reason: "invalid_payload", details: "Missing required fields" });
  }

  const validScopes = ["category", "merchant", "customer", "trigger"];
  if (!validScopes.includes(scope)) {
    return res.status(400).json({ accepted: false, reason: "invalid_scope", details: `Scope must be one of: ${validScopes.join(", ")}` });
  }

  const result = setContext(scope, context_id, version, payload);

  if (!result.accepted) {
    return res.status(409).json(result);
  }

  res.json({
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at: new Date().toISOString(),
  });
});

// ─── POST /v1/tick ─────────────────────────────────────────────────────────

app.post("/v1/tick", async (req, res) => {
  const { now, available_triggers = [] } = req.body;
  const actions = [];

  for (const trigId of available_triggers) {
    try {
      const trigger = getTrigger(trigId);
      if (!trigger) continue;

      const merchantId = trigger.merchant_id;
      const customerId = trigger.customer_id || null;
      if (!merchantId) continue;

      const merchant = getMerchant(merchantId);
      if (!merchant) continue;

      // Check suppression
      const suppKey = trigger.suppression_key;
      if (suppKey && isSuppressed(suppKey)) continue;

      // Check expiry
      if (trigger.expires_at && new Date(trigger.expires_at) < new Date(now || Date.now())) continue;

      // Check if there's already an active conversation for this merchant+trigger
      const activeConvs = getActiveConversationsForMerchant(merchantId);
      const alreadyEngaged = activeConvs.some(c => c.trigger_id === trigId);
      if (alreadyEngaged) continue;

      // Compose
      const composed = await composeMessage(trigId, merchantId, customerId);
      if (!composed || !composed.body) continue;

      const isCustomerFacing = trigger.scope === "customer" && customerId;
      const convId = `conv_${merchantId}_${trigId}_${Date.now()}`;

      // Create conversation
      createConversation(convId, { merchantId, customerId, triggerId: trigId });
      addTurn(convId, "vera", composed.body);
      recordSentBody(convId, composed.body);

      // Mark suppressed
      if (suppKey) addSuppression(suppKey);

      // Build template params
      const ownerName = merchant.identity?.owner_first_name || merchant.identity?.name || "";
      const templateParams = [ownerName, composed.body.slice(0, 100), composed.body.slice(100, 200)];

      actions.push({
        conversation_id: convId,
        merchant_id: merchantId,
        customer_id: customerId,
        send_as: composed.send_as || (isCustomerFacing ? "merchant_on_behalf" : "vera"),
        trigger_id: trigId,
        template_name: `vera_${trigger.kind}_v1`,
        template_params: templateParams,
        body: composed.body,
        cta: composed.cta || "open_ended",
        suppression_key: suppKey || "",
        rationale: composed.rationale || `Composed from ${merchant.category_slug} category + merchant + ${trigger.kind} trigger context.`,
      });

      // Cap at 20 actions per tick
      if (actions.length >= 20) break;
    } catch (err) {
      console.error(`[Tick] Error processing trigger ${trigId}:`, err.message);
    }
  }

  res.json({ actions });
});

// ─── POST /v1/reply ────────────────────────────────────────────────────────

app.post("/v1/reply", async (req, res) => {
  const { conversation_id, merchant_id, customer_id, from_role, message, received_at, turn_number } = req.body;

  if (!conversation_id || !message) {
    return res.status(400).json({ action: "end", rationale: "Missing conversation_id or message" });
  }

  // Get or create conversation
  let conv = getConversation(conversation_id);
  if (!conv) {
    conv = createConversation(conversation_id, {
      merchantId: merchant_id,
      customerId: customer_id,
      triggerId: null,
    });
  }

  // Check if conversation already ended
  if (conv.ended) {
    return res.json({ action: "end", rationale: "Conversation was previously ended." });
  }

  // Record the incoming turn
  addTurn(conversation_id, from_role, message);

  try {
    // Compose reply
    const reply = await composeReply(conversation_id, merchant_id, from_role, message, turn_number, conv);

    if (!reply) {
      return res.json({ action: "send", body: "Got it, let me check on that for you.", cta: "open_ended", rationale: "Fallback acknowledgment." });
    }

    // Handle end action
    if (reply.action === "end") {
      endConversation(conversation_id);
      return res.json({ action: "end", rationale: reply.rationale || "Conversation ended." });
    }

    // Handle wait action
    if (reply.action === "wait") {
      return res.json({ action: "wait", wait_seconds: reply.wait_seconds || 1800, rationale: reply.rationale || "Waiting." });
    }

    // Handle send — check for body duplication
    if (reply.body && isBodyDuplicate(conversation_id, reply.body)) {
      // Modify slightly to avoid exact repetition
      reply.body = reply.body + " (anything else I can help with?)";
    }

    // Record outgoing
    if (reply.body) {
      addTurn(conversation_id, "vera", reply.body);
      recordSentBody(conversation_id, reply.body);
    }

    return res.json({
      action: "send",
      body: reply.body || "Let me look into that.",
      cta: reply.cta || "open_ended",
      rationale: reply.rationale || "Contextual reply.",
    });
  } catch (err) {
    console.error(`[Reply] Error:`, err.message);
    return res.json({ action: "send", body: "Got it, working on it.", cta: "open_ended", rationale: "Error recovery fallback." });
  }
});

// ─── POST /v1/teardown (optional) ──────────────────────────────────────────

app.post("/v1/teardown", (_req, res) => {
  console.log("[Teardown] Wiping state.");
  res.json({ status: "ok" });
});

// ─── Start server ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Vera Challenge Bot — running on http://localhost:${PORT}`);
  console.log(`  Team: ${TEAM.team_name}`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /v1/healthz`);
  console.log(`    GET  /v1/metadata`);
  console.log(`    POST /v1/context`);
  console.log(`    POST /v1/tick`);
  console.log(`    POST /v1/reply`);
  console.log(`${"=".repeat(60)}\n`);
});
