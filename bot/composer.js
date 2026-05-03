import { llmComplete, isLLMConfigured } from "./llm.js";
import { getCategory, getMerchant, getCustomer, getTrigger } from "./store.js";

const SYSTEM_PROMPT = `You are Vera, magicpin's merchant AI assistant on WhatsApp. You compose messages for Indian merchants and their customers.

RULES:
- Be specific: use real numbers, dates, sources from context. Never fabricate.
- Match category voice (dentists=clinical-peer, salons=warm-practical, restaurants=operator, gyms=coaching, pharmacies=trustworthy-precise)
- Use owner's first name. Honor language preference (hindi-english code-mix when merchant uses hi).
- Single clear CTA at the end. No multiple CTAs.
- Keep concise. No long preambles. No "I hope you're doing well".
- For customer-facing (send_as=merchant_on_behalf): use merchant's name, warm tone, no overclaims.

OUTPUT JSON ONLY:
{"body":"...","cta":"open_ended|binary_yes_no|binary_confirm_cancel|multi_choice_slot|none","send_as":"vera|merchant_on_behalf","rationale":"..."}`;

export async function composeMessage(triggerId, merchantId, customerId) {
  const trigger = getTrigger(triggerId);
  const merchant = getMerchant(merchantId);
  if (!trigger || !merchant) return null;

  const catSlug = merchant.category_slug || trigger.payload?.category;
  const category = getCategory(catSlug);
  const customer = customerId ? getCustomer(customerId) : null;
  const isCustomerFacing = trigger.scope === "customer" && customer;

  if (isLLMConfigured()) {
    return await composeLLM(category, merchant, trigger, customer, isCustomerFacing);
  }
  return composeRuleBased(category, merchant, trigger, customer, isCustomerFacing);
}

async function composeLLM(category, merchant, trigger, customer, isCustomerFacing) {
  const digest = category?.digest || [];
  const topDigest = trigger.payload?.top_item_id ? digest.find(d => d.id === trigger.payload.top_item_id) : digest[0];

  const prompt = `COMPOSE a WhatsApp message for this context:

CATEGORY: ${category?.slug || "unknown"} | Voice: ${category?.voice?.tone || "professional"} | Taboos: ${JSON.stringify(category?.voice?.vocab_taboo || [])}
Peer stats: ${JSON.stringify(category?.peer_stats || {})}
${topDigest ? `Digest item: ${JSON.stringify(topDigest)}` : ""}

MERCHANT: ${merchant.identity?.name} (${merchant.identity?.owner_first_name}) | ${merchant.identity?.locality}, ${merchant.identity?.city}
Languages: ${JSON.stringify(merchant.identity?.languages || ["en"])}
Subscription: ${merchant.subscription?.status} (${merchant.subscription?.days_remaining || 0} days left)
Performance 30d: views=${merchant.performance?.views}, calls=${merchant.performance?.calls}, ctr=${merchant.performance?.ctr}
7d delta: ${JSON.stringify(merchant.performance?.delta_7d || {})}
Active offers: ${JSON.stringify((merchant.offers || []).filter(o => o.status === "active").map(o => o.title))}
Signals: ${JSON.stringify(merchant.signals || [])}
Customer aggregate: ${JSON.stringify(merchant.customer_aggregate || {})}
Review themes: ${JSON.stringify(merchant.review_themes || [])}

TRIGGER: kind=${trigger.kind} | source=${trigger.source} | urgency=${trigger.urgency}
Payload: ${JSON.stringify(trigger.payload)}

${customer ? `CUSTOMER: ${customer.identity?.name} | State: ${customer.state} | Lang: ${customer.identity?.language_pref}
Relationship: ${JSON.stringify(customer.relationship || {})}
Preferences: ${JSON.stringify(customer.preferences || {})}
This is CUSTOMER-FACING. Send as merchant_on_behalf.` : "This is MERCHANT-FACING. Send as vera."}

Respond with JSON only.`;

  try {
    const raw = await llmComplete(prompt, SYSTEM_PROMPT, { temperature: 0.15, maxTokens: 1200 });
    if (!raw) return composeRuleBased(null, merchant, trigger, customer, isCustomerFacing);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return composeRuleBased(null, merchant, trigger, customer, isCustomerFacing);
    const parsed = JSON.parse(match[0]);
    return {
      body: parsed.body || "",
      cta: parsed.cta || "open_ended",
      send_as: isCustomerFacing ? "merchant_on_behalf" : (parsed.send_as || "vera"),
      rationale: parsed.rationale || "",
    };
  } catch (e) {
    console.error("[Composer] LLM parse error:", e.message);
    return composeRuleBased(null, merchant, trigger, customer, isCustomerFacing);
  }
}

// ─── Rule-based fallback (no LLM needed) ──────────────────────────────────

function composeRuleBased(category, merchant, trigger, customer, isCustomerFacing) {
  const name = merchant?.identity?.owner_first_name || merchant?.identity?.name || "there";
  const bizName = merchant?.identity?.name || "your business";
  const kind = trigger?.kind || "general";
  const payload = trigger?.payload || {};

  if (isCustomerFacing && customer) {
    return composeCustomerFacing(merchant, trigger, customer, category);
  }

  const composers = {
    research_digest: () => {
      const digest = category?.digest?.find(d => d.id === payload.top_item_id) || category?.digest?.[0];
      if (digest) {
        return msg(`Dr. ${name}, ${digest.source?.split(",")[0] || "latest research"} just dropped. Key finding for your patients — ${digest.title}. ${digest.trial_n ? `(${digest.trial_n.toLocaleString()}-patient trial)` : ""} Want me to pull the abstract + draft a patient-ed WhatsApp? — ${digest.source}`, "open_ended");
      }
      return msg(`${name}, new research digest available for ${category?.slug || "your category"}. Want me to summarize the key items relevant to your practice?`, "open_ended");
    },
    regulation_change: () => {
      const digest = category?.digest?.find(d => d.id === payload.top_item_id);
      if (digest) {
        return msg(`${name}, compliance update: ${digest.title}. Deadline: ${payload.deadline_iso?.slice(0, 10) || "check circular"}. ${digest.actionable || "Review your setup."}  Want me to help audit? — ${digest.source}`, "binary_yes_no");
      }
      return msg(`${name}, new regulation change affects your category. Want me to break down what you need to do?`, "open_ended");
    },
    perf_dip: () => {
      const metric = payload.metric || "views";
      const delta = payload.delta_pct ? `${Math.round(Math.abs(payload.delta_pct) * 100)}%` : "significantly";
      return msg(`${name}, your ${metric} dropped ${delta} this week vs baseline. This needs attention — want me to run a quick diagnostic on what changed and suggest 2-3 fixes?`, "binary_yes_no");
    },
    perf_spike: () => {
      const metric = payload.metric || "views";
      const delta = payload.delta_pct ? `+${Math.round(payload.delta_pct * 100)}%` : "up";
      const driver = payload.likely_driver ? ` (likely driven by ${payload.likely_driver.replace(/_/g, " ")})` : "";
      return msg(`${name}, nice — your ${metric} are ${delta} this week${driver}. Want me to double down on what's working? I can draft a follow-up post or push your best offer.`, "open_ended");
    },
    seasonal_perf_dip: () => {
      const delta = payload.delta_pct ? `${Math.round(Math.abs(payload.delta_pct) * 100)}%` : "some";
      const note = payload.season_note?.replace(/_/g, " ") || "seasonal pattern";
      return msg(`${name}, your views are down ${delta} this week — but this is the normal ${note}. Every similar business sees this. Action: focus retention on your ${merchant?.customer_aggregate?.total_active_members || "existing"} members now, save ad spend for the Sept-Oct surge. Want me to draft a retention challenge?`, "open_ended");
    },
    milestone_reached: () => {
      const metric = payload.metric?.replace(/_/g, " ") || "milestone";
      const val = payload.value_now || payload.milestone_value;
      return msg(`${name}, you're at ${val} ${metric}${payload.is_imminent ? " — almost at the next milestone!" : "!"}. Want me to draft a thank-you post for your customers? Social proof at this level drives more walk-ins.`, "binary_yes_no");
    },
    renewal_due: () => {
      const days = payload.days_remaining || merchant?.subscription?.days_remaining || "a few";
      return msg(`${name}, your ${payload.plan || "Pro"} subscription renews in ${days} days (₹${payload.renewal_amount || "—"}). Your profile has been driving ${merchant?.performance?.views || "good"} views/month. Want me to lock in renewal so there's no gap?`, "binary_yes_no");
    },
    dormant_with_vera: () => {
      const days = payload.days_since_last_merchant_message || 14;
      return msg(`${name}, it's been ${days} days — just checking in. ${bizName} is still getting ${merchant?.performance?.views || "steady"} views on Google. Anything I can help with this week? Even a quick Google post keeps your profile fresh.`, "open_ended");
    },
    festival_upcoming: () => {
      const fest = payload.festival || "upcoming festival";
      const daysUntil = payload.days_until;
      return msg(`${name}, ${fest}${daysUntil ? ` is ${daysUntil} days away` : " is coming up"}. Want me to draft a ${fest} special offer + a Google post? I'll match it to what's working in ${merchant?.identity?.locality || "your area"}.`, "binary_yes_no");
    },
    ipl_match_today: () => {
      const match = payload.match || "IPL match";
      return msg(`Quick heads-up ${name} — ${match} at ${payload.venue || "nearby"} tonight, ${payload.match_time_iso?.slice(11, 16) || "7:30pm"}. ${payload.is_weeknight === false ? "Saturday IPL usually shifts covers to home-delivery." : "Weeknight match = extra delivery demand."} Want me to push your ${(merchant?.offers || []).find(o => o.status === "active")?.title || "best offer"} as a match-night special?`, "binary_yes_no");
    },
    review_theme_emerged: () => {
      const theme = payload.theme?.replace(/_/g, " ") || "a pattern";
      const count = payload.occurrences_30d || "several";
      const quote = payload.common_quote;
      return msg(`${name}, ${count} reviews this month mention "${theme}"${quote ? ` ("${quote}")` : ""}. ${payload.trend === "rising" ? "Trend is rising." : ""} Want me to draft a response template + suggest an operational fix?`, "open_ended");
    },
    curious_ask_due: () => {
      return msg(`Hi ${name}! Quick check — what service has been most asked-for this week at ${bizName}? I'll turn it into a Google post + a WhatsApp reply template. Takes 5 min.`, "open_ended");
    },
    competitor_opened: () => {
      const comp = payload.competitor_name || "a new competitor";
      const dist = payload.distance_km ? `${payload.distance_km}km away` : "nearby";
      return msg(`${name}, ${comp} opened ${dist}${payload.their_offer ? ` with "${payload.their_offer}"` : ""}. Want to see how your profile compares? I can highlight your strengths in a Google post.`, "open_ended");
    },
    winback_eligible: () => {
      const days = payload.days_since_expiry || 30;
      return msg(`${name}, it's been ${days} days since your subscription paused. Your profile views dropped ${payload.perf_dip_pct ? Math.round(Math.abs(payload.perf_dip_pct) * 100) + "%" : ""}. ${payload.lapsed_customers_added_since_expiry ? `${payload.lapsed_customers_added_since_expiry} customers lapsed in this period.` : ""} Want to reactivate and recover?`, "binary_yes_no");
    },
    supply_alert: () => {
      const mol = payload.molecule || "a product";
      const batches = payload.affected_batches?.join(", ") || "";
      return msg(`${name}, urgent: voluntary recall on ${mol} batches${batches ? ` (${batches})` : ""} by ${payload.manufacturer || "manufacturer"}. Want me to pull your affected customer list + draft their notification?`, "binary_yes_no");
    },
    category_seasonal: () => {
      const trends = payload.trends?.slice(0, 3).map(t => t.replace(/_/g, " ")).join(", ") || "seasonal shifts";
      return msg(`${name}, summer demand data is in: ${trends}. ${payload.shelf_action_recommended ? "Shelf reorganization recommended." : ""} Want a visual planogram suggestion?`, "open_ended");
    },
    gbp_unverified: () => {
      const uplift = payload.estimated_uplift_pct ? `${Math.round(payload.estimated_uplift_pct * 100)}%` : "significant";
      return msg(`${name}, your Google Business Profile is still unverified. Verified profiles typically see ${uplift} more visibility. Verification takes ${payload.verification_path?.replace(/_/g, " ") || "a few days"}. Want me to walk you through it?`, "binary_yes_no");
    },
    active_planning_intent: () => {
      const topic = payload.intent_topic?.replace(/_/g, " ") || "your idea";
      return msg(`${name}, following up on ${topic} — I've drafted a starter plan. Want me to share it so you can review and edit?`, "binary_yes_no");
    },
    cde_opportunity: () => {
      const digest = category?.digest?.find(d => d.id === payload.digest_item_id);
      if (digest) {
        return msg(`${name}, ${digest.title} — ${digest.date?.slice(0, 10) || "coming soon"}. ${payload.credits} CDE credits, ${payload.fee || "check fees"}. ${digest.summary || ""} Worth attending?`, "open_ended");
      }
      return msg(`${name}, a CDE opportunity is available — ${payload.credits || 2} credits. Want details?`, "open_ended");
    },
  };

  const fn = composers[kind];
  if (fn) return fn();
  return msg(`${name}, I have an update relevant to ${bizName}. Want me to share the details?`, "open_ended");
}

function composeCustomerFacing(merchant, trigger, customer, category) {
  const custName = customer.identity?.name || "there";
  const bizName = merchant.identity?.name || "us";
  const lang = customer.identity?.language_pref || "en";
  const useHindi = lang.includes("hi");
  const kind = trigger.kind;
  const payload = trigger.payload || {};

  if (kind === "recall_due") {
    const slots = payload.available_slots || [];
    const slotText = slots.map((s, i) => `${i + 1}. ${s.label}`).join(" ya ");
    const offer = (merchant.offers || []).find(o => o.status === "active");
    const body = useHindi
      ? `Hi ${custName}, ${bizName} here 🦷 ${useHindi ? "Aapki" : "Your"} ${payload.service_due?.replace(/_/g, " ") || "cleaning"} due hai. ${slotText ? `Slots ready hain: ${slotText}.` : ""} ${offer ? `${offer.title}.` : ""} Reply with slot number or apna time batayein.`
      : `Hi ${custName}, ${bizName} here 🦷 Your ${payload.service_due?.replace(/_/g, " ") || "cleaning"} is due. ${slotText ? `Available slots: ${slotText}.` : ""} ${offer ? `${offer.title}.` : ""} Reply with your preferred slot.`;
    return { body, cta: "multi_choice_slot", send_as: "merchant_on_behalf", rationale: `Recall reminder for ${custName}, honoring ${lang} preference + available slots from trigger payload.` };
  }

  if (kind === "chronic_refill_due") {
    const mols = payload.molecule_list?.join(", ") || "your medicines";
    const date = payload.stock_runs_out_iso?.slice(0, 10) || "soon";
    const senior = customer.identity?.senior_citizen;
    const seniorDisc = (merchant.offers || []).find(o => o.title?.toLowerCase().includes("senior"));
    const body = useHindi
      ? `Namaste — ${bizName} yahan. ${custName} ${senior ? "ji" : ""} ki medicines (${mols}) ${date} ko khatam hongi. Same dose ready hai. ${seniorDisc ? `Senior discount applied.` : ""} ${payload.delivery_address_saved ? "Saved address pe delivery." : ""} Reply CONFIRM to dispatch.`
      : `Hi, ${bizName} here. ${custName}'s medicines (${mols}) run out ${date}. Same dose ready. ${seniorDisc ? `Senior discount applied.` : ""} ${payload.delivery_address_saved ? "Free delivery to saved address." : ""} Reply CONFIRM to dispatch.`;
    return { body, cta: "binary_confirm_cancel", send_as: "merchant_on_behalf", rationale: `Chronic refill reminder with specific molecules and date.` };
  }

  if (kind === "customer_lapsed_hard" || kind === "customer_lapsed_soft") {
    const days = payload.days_since_last_visit || 60;
    const focus = payload.previous_focus?.replace(/_/g, " ") || "";
    const offer = (merchant.offers || []).find(o => o.status === "active");
    const body = `Hi ${custName} 👋 ${merchant.identity?.owner_first_name || bizName} here. It's been about ${Math.round(days / 7)} weeks — no judgment. ${focus ? `We have new options matching your ${focus} goals.` : ""} ${offer ? `${offer.title} available.` : ""} Want me to hold a spot for you? Reply YES — no commitment.`;
    return { body, cta: "binary_yes_no", send_as: "merchant_on_behalf", rationale: `Lapsed customer winback with no-shame framing.` };
  }

  if (kind === "trial_followup") {
    const slots = payload.next_session_options || [];
    const body = `Hi ${custName}, ${bizName} here! Hope you enjoyed the trial session. ${slots.length ? `Next available: ${slots[0].label}.` : ""} Ready to continue? Reply YES to book.`;
    return { body, cta: "binary_yes_no", send_as: "merchant_on_behalf", rationale: `Trial followup with next session slot.` };
  }

  if (kind === "wedding_package_followup") {
    const days = payload.days_to_wedding || 180;
    const body = `Hi ${custName} 💍 ${merchant.identity?.owner_first_name || bizName} here. ${days} days to your wedding — perfect time for the ${payload.next_step_window_open?.replace(/_/g, " ") || "prep program"}. Want me to block your preferred slot?`;
    return { body, cta: "binary_yes_no", send_as: "merchant_on_behalf", rationale: `Bridal followup with wedding countdown.` };
  }

  return { body: `Hi ${custName}, ${bizName} here. We have an update for you — reply to know more.`, cta: "open_ended", send_as: "merchant_on_behalf", rationale: "Generic customer-facing fallback." };
}

function msg(body, cta) {
  return { body, cta, send_as: "vera", rationale: `Trigger-specific composition with merchant context personalization.` };
}

// ─── Reply composer ────────────────────────────────────────────────────────

const AUTO_REPLY_PATTERNS = [
  "thank you for contacting", "our team will respond", "we will get back",
  "automated", "auto-reply", "currently unavailable", "thank you for reaching out",
  "please leave a message", "we are currently closed", "your message is important",
];

export function detectAutoReply(message) {
  const lower = (message || "").toLowerCase();
  return AUTO_REPLY_PATTERNS.some(p => lower.includes(p));
}

export async function composeReply(convId, merchantId, fromRole, message, turnNumber, conv) {
  const merchant = getMerchant(merchantId);
  const lower = (message || "").toLowerCase().trim();

  // 1. Auto-reply detection
  if (detectAutoReply(message)) {
    conv.auto_reply_count = (conv.auto_reply_count || 0) + 1;
    if (conv.auto_reply_count >= 3) {
      return { action: "end", rationale: `Auto-reply ${conv.auto_reply_count}x — no real engagement. Closing.` };
    }
    if (conv.auto_reply_count >= 2) {
      return { action: "wait", wait_seconds: 86400, rationale: `Same auto-reply ${conv.auto_reply_count}x — owner not at phone. Wait 24h.` };
    }
    return { action: "send", body: `Looks like an auto-reply 😊 When the owner sees this, just reply 'Yes' to continue.`, cta: "binary_yes_no", rationale: "Detected auto-reply; one explicit prompt to flag for owner." };
  }

  // 2. Hostile / opt-out detection
  const hostilePatterns = ["stop messaging", "stop sending", "unsubscribe", "don't contact", "leave me alone", "useless spam", "block", "not interested. stop"];
  if (hostilePatterns.some(p => lower.includes(p))) {
    return { action: "end", rationale: "Merchant explicitly opted out. Closing conversation; suppressing future contact." };
  }

  // Softer rejection
  if (/^(not interested|no thanks|nahi|nahi chahiye|mat karo)/.test(lower)) {
    return { action: "send", body: `No problem at all. If anything changes, just say 'Hi Vera'. Best wishes! 🙏`, cta: "none", rationale: "Soft rejection — graceful single-line exit." };
  }

  // 3. Intent transition — merchant says yes / let's do it
  const commitPatterns = ["yes", "ok let", "let's do it", "go ahead", "haan", "kar do", "proceed", "chalo", "sure", "done deal", "yes please", "haan please"];
  if (commitPatterns.some(p => lower.startsWith(p) || lower.includes(p))) {
    if (isLLMConfigured()) {
      const actionReply = await composeActionReplyLLM(merchant, conv, message);
      if (actionReply) return actionReply;
    }
    const name = merchant?.identity?.owner_first_name || "there";
    return { action: "send", body: `Great ${name}! Working on it now — I'll have everything ready in a moment. Will share the draft for your review.`, cta: "open_ended", rationale: "Merchant committed; switching to action mode immediately." };
  }

  // 4. Off-topic detection
  const offTopicPatterns = ["gst", "tax filing", "aadhaar", "pan card", "bank loan", "passport"];
  if (offTopicPatterns.some(p => lower.includes(p))) {
    return { action: "send", body: `That's outside what I can help with directly — you'd need a specialist for that. Coming back to what we were discussing — want me to continue?`, cta: "open_ended", rationale: "Off-topic ask politely declined; redirecting to original thread." };
  }

  // 5. LLM-powered contextual reply
  if (isLLMConfigured()) {
    return await composeContextualReplyLLM(merchant, conv, message, turnNumber);
  }

  // 6. Rule-based generic follow-up
  return { action: "send", body: `Got it! Let me work on that. I'll share the details shortly.`, cta: "open_ended", rationale: "Acknowledged merchant response + advancing conversation." };
}

async function composeActionReplyLLM(merchant, conv, message) {
  const history = conv.turns.slice(-4).map(t => `[${t.from}] ${t.body}`).join("\n");
  const prompt = `The merchant just COMMITTED: "${message}"
Context: ${merchant?.identity?.name}, ${merchant?.identity?.locality}
Conversation so far:
${history}

The merchant said YES. You MUST switch to ACTION mode — describe what you're doing, give concrete next steps. Do NOT ask qualifying questions. Be specific.

Respond JSON: {"body":"...","cta":"binary_confirm_cancel|open_ended|none"}`;

  try {
    const raw = await llmComplete(prompt, "You are Vera, switching to action mode. Be concrete and specific. No qualifying questions.", { temperature: 0.1, maxTokens: 500 });
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);
    return { action: "send", body: p.body, cta: p.cta || "open_ended", rationale: "Intent transition: merchant committed, switched to action mode." };
  } catch { return null; }
}

async function composeContextualReplyLLM(merchant, conv, message, turnNumber) {
  const history = conv.turns.slice(-6).map(t => `[${t.from}] ${t.body}`).join("\n");
  const prompt = `Continue this WhatsApp conversation as Vera.
Merchant: ${merchant?.identity?.name} (${merchant?.identity?.owner_first_name}), ${merchant?.identity?.locality} ${merchant?.identity?.city}
Category: ${merchant?.category_slug}

Conversation:
${history}
[merchant] ${message}

Rules: Be concise, specific, helpful. Match their language. If they ask a question, answer it. If they're engaged, advance. If 5+ turns deep, wrap up.
${turnNumber >= 5 ? "This conversation is getting long — try to wrap up with a clear next action." : ""}

Respond JSON: {"action":"send|wait|end","body":"...","cta":"open_ended|binary_yes_no|none","rationale":"..."}`;

  try {
    const raw = await llmComplete(prompt, "You are Vera. Keep replies short and actionable.", { temperature: 0.2, maxTokens: 500 });
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);
    return { action: p.action || "send", body: p.body, cta: p.cta || "open_ended", wait_seconds: p.wait_seconds, rationale: p.rationale || "Contextual reply." };
  } catch { return null; }
}
