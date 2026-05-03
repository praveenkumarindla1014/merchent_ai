#!/usr/bin/env node
/**
 * Node.js Judge Test — runs all judge scenarios against the bot
 * Usage: node test_judge.js [bot_url]
 */

const BOT = process.argv[2] || "http://localhost:8090";
const fs = await import("fs");
const path = await import("path");

const DATASET = path.resolve(import.meta.dirname, "../dataset");

const C = { R: "\x1b[0m", G: "\x1b[32m", Y: "\x1b[33m", RED: "\x1b[31m", B: "\x1b[1m", C: "\x1b[36m", M: "\x1b[35m", D: "\x1b[2m" };
const pass = t => console.log(`${C.G}[PASS]${C.R} ${t}`);
const fail = t => console.log(`${C.RED}[FAIL]${C.R} ${t}`);
const info = t => console.log(`${C.C}[INFO]${C.R} ${t}`);
const head = t => { console.log(`\n${C.B}${C.M}${"=".repeat(60)}${C.R}`); console.log(`${C.B}${C.M}${t.padStart(30 + t.length/2).padEnd(60)}${C.R}`); console.log(`${C.B}${C.M}${"=".repeat(60)}${C.R}\n`); };

async function req(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${BOT}${path}`, opts);
    return { data: await r.json(), status: r.status, ok: r.ok };
  } catch (e) { return { data: null, error: e.message }; }
}

function loadJSON(file) { return JSON.parse(fs.readFileSync(path.join(DATASET, file), "utf-8")); }

let totalScore = 0, totalTests = 0, passed = 0;

// ─── PHASE 1: WARMUP ──────────────────────────────────────────────────────
head("PHASE 1: WARMUP");

// Healthz
let { data, error } = await req("GET", "/v1/healthz");
if (error) { fail(`Healthz unreachable: ${error}`); process.exit(1); }
pass(`Healthz: status=${data.status}, uptime=${data.uptime_seconds}s`);
totalTests++; passed++;

// Metadata
({ data } = await req("GET", "/v1/metadata"));
if (data?.team_name) { pass(`Metadata: team=${data.team_name}, model=${data.model}`); passed++; }
else { fail("Metadata missing"); }
totalTests++;

// Push categories
const cats = ["dentists", "salons", "restaurants", "gyms", "pharmacies"];
let catPushed = 0;
for (const c of cats) {
  const payload = loadJSON(`categories/${c}.json`);
  const { data: d } = await req("POST", "/v1/context", { scope: "category", context_id: c, version: 10, payload, delivered_at: new Date().toISOString() });
  if (d?.accepted) catPushed++;
}
(catPushed === 5 ? pass : fail)(`Categories pushed: ${catPushed}/5`);
totalTests++; if (catPushed === 5) passed++;

// Push merchants
const merchants = loadJSON("merchants_seed.json").merchants;
let mPushed = 0;
for (const m of merchants) {
  const { data: d } = await req("POST", "/v1/context", { scope: "merchant", context_id: m.merchant_id, version: 10, payload: m, delivered_at: new Date().toISOString() });
  if (d?.accepted) mPushed++;
}
(mPushed === merchants.length ? pass : fail)(`Merchants pushed: ${mPushed}/${merchants.length}`);
totalTests++; if (mPushed === merchants.length) passed++;

// Push customers
const customers = loadJSON("customers_seed.json").customers;
let cPushed = 0;
for (const c of customers) {
  const { data: d } = await req("POST", "/v1/context", { scope: "customer", context_id: c.customer_id, version: 10, payload: c, delivered_at: new Date().toISOString() });
  if (d?.accepted) cPushed++;
}
(cPushed === customers.length ? pass : fail)(`Customers pushed: ${cPushed}/${customers.length}`);
totalTests++; if (cPushed === customers.length) passed++;

// Push triggers with future expiry
const triggers = loadJSON("triggers_seed.json").triggers;
let tPushed = 0;
for (const t of triggers) {
  const mod = { ...t, expires_at: "2028-12-31T00:00:00Z", suppression_key: t.suppression_key + "_judge_" + Date.now() };
  const { data: d } = await req("POST", "/v1/context", { scope: "trigger", context_id: t.id + "_judge", version: 10, payload: mod, delivered_at: new Date().toISOString() });
  if (d?.accepted) tPushed++;
}
(tPushed === triggers.length ? pass : fail)(`Triggers pushed: ${tPushed}/${triggers.length}`);
totalTests++; if (tPushed === triggers.length) passed++;

// Healthz after warmup
({ data } = await req("GET", "/v1/healthz"));
info(`Contexts loaded: ${JSON.stringify(data?.contexts_loaded)}`);

// ─── PHASE 2: TICK TEST ────────────────────────────────────────────────────
head("PHASE 2: TICK + COMPOSITION");

const trigIds = triggers.map(t => t.id + "_judge");
({ data } = await req("POST", "/v1/tick", { now: "2026-05-03T10:00:00Z", available_triggers: trigIds }));

const actions = data?.actions || [];
info(`Tick returned ${actions.length} actions`);
totalTests++;
if (actions.length >= 10) { pass(`Sufficient actions (${actions.length} >= 10)`); passed++; }
else { fail(`Too few actions: ${actions.length}`); }

// Score each action
let composeScore = 0;
for (const a of actions) {
  const body = a.body || "";
  const trig = triggers.find(t => t.id + "_judge" === a.trigger_id) || {};
  const merchant = merchants.find(m => m.merchant_id === a.merchant_id) || {};
  const kind = trig.kind || "?";

  let score = 0;
  const checks = [];

  // Specificity: has numbers?
  const nums = body.match(/\d+/g) || [];
  if (nums.length >= 2) { score += 2; checks.push("numbers✓"); }
  else if (nums.length >= 1) { score += 1; checks.push("1 number"); }

  // Merchant fit: uses name?
  const ownerName = merchant.identity?.owner_first_name || "";
  if (ownerName && body.includes(ownerName)) { score += 2; checks.push("name✓"); }

  // CTA present?
  if (a.cta && a.cta !== "none") { score += 1; checks.push("cta✓"); }

  // send_as correct?
  const isCustomerTrigger = trig.scope === "customer";
  if (isCustomerTrigger && a.send_as === "merchant_on_behalf") { score += 1; checks.push("send_as✓"); }
  else if (!isCustomerTrigger && a.send_as === "vera") { score += 1; checks.push("send_as✓"); }

  // Not too short
  if (body.length > 50) { score += 1; checks.push("length✓"); }

  // Has rationale
  if (a.rationale?.length > 10) { score += 1; checks.push("rationale✓"); }

  // Required fields
  if (a.conversation_id && a.trigger_id && a.suppression_key !== undefined) { score += 1; checks.push("fields✓"); }

  // No taboo words for dentists
  if (merchant.category_slug === "dentists" && /guaranteed|100% safe|miracle/i.test(body)) { score -= 2; checks.push("TABOO!"); }

  const maxPossible = 9;
  const pct = Math.round((score / maxPossible) * 100);
  const color = pct >= 70 ? C.G : pct >= 40 ? C.Y : C.RED;

  console.log(`  ${color}${score}/${maxPossible}${C.R} ${C.D}[${checks.join(", ")}]${C.R} ${kind} → ${body.slice(0, 80)}...`);
  composeScore += score;
}

const avgCompose = actions.length ? Math.round(composeScore / actions.length * 10) / 10 : 0;
info(`Average composition score: ${avgCompose}/9`);

// ─── PHASE 3: CONVERSATION TESTS ──────────────────────────────────────────
head("PHASE 3: CONVERSATION HANDLING");

// Auto-reply test
info("Testing auto-reply detection...");
const autoMsg = "Thank you for contacting us! Our team will respond shortly.";
let autoScore = 0;
const autoConvId = `judge_auto_${Date.now()}`;
for (let i = 1; i <= 4; i++) {
  const { data: d } = await req("POST", "/v1/reply", {
    conversation_id: autoConvId, merchant_id: merchants[0].merchant_id,
    from_role: "merchant", message: autoMsg, received_at: new Date().toISOString(), turn_number: i + 1
  });
  const action = d?.action;
  if (i <= 2 && (action === "send" || action === "wait")) { autoScore++; }
  if (i >= 3 && (action === "end" || action === "wait")) { autoScore++; }
  console.log(`  Turn ${i}: ${action} ${action === "end" ? "✓ (ended)" : action === "wait" ? `✓ (wait ${d.wait_seconds}s)` : `→ "${(d.body || "").slice(0, 50)}"`}`);
}
totalTests++; if (autoScore >= 3) { pass(`Auto-reply: ${autoScore}/4 correct`); passed++; } else { fail(`Auto-reply: ${autoScore}/4`); }

// Intent transition test
info("Testing intent transition...");
const { data: intentData } = await req("POST", "/v1/reply", {
  conversation_id: `judge_intent_${Date.now()}`, merchant_id: merchants[0].merchant_id,
  from_role: "merchant", message: "Ok let's do it. What's next?", received_at: new Date().toISOString(), turn_number: 3
});
const intentBody = (intentData?.body || "").toLowerCase();
const intentAction = intentData?.action;
const qualifyingWords = ["would you", "do you", "can you tell", "what if"];
const actionWords = ["done", "sending", "draft", "here", "confirm", "proceed", "next", "working", "ready", "review"];
totalTests++;
if (intentAction === "send" && actionWords.some(w => intentBody.includes(w)) && !qualifyingWords.some(w => intentBody.includes(w))) {
  pass(`Intent transition: action mode ✓ ("${intentBody.slice(0, 60)}...")`);
  passed++;
} else {
  fail(`Intent transition: "${intentBody.slice(0, 80)}"`);
}

// Hostile test
info("Testing hostile handling...");
const { data: hostileData } = await req("POST", "/v1/reply", {
  conversation_id: `judge_hostile_${Date.now()}`, merchant_id: merchants[0].merchant_id,
  from_role: "merchant", message: "Stop messaging me. This is useless spam.", received_at: new Date().toISOString(), turn_number: 2
});
totalTests++;
if (hostileData?.action === "end") {
  pass("Hostile: graceful exit ✓");
  passed++;
} else if (hostileData?.action === "send" && /sorry|apolog|won't/i.test(hostileData.body || "")) {
  pass("Hostile: apologized + exit ✓");
  passed++;
} else {
  fail(`Hostile: action=${hostileData?.action}`);
}

// Idempotency test
info("Testing context idempotency...");
const { data: idem1 } = await req("POST", "/v1/context", { scope: "category", context_id: "dentists", version: 10, payload: loadJSON("categories/dentists.json"), delivered_at: new Date().toISOString() });
totalTests++;
if (idem1?.accepted === false && idem1?.reason === "stale_version") {
  pass("Idempotency: stale_version on same version ✓");
  passed++;
} else {
  fail(`Idempotency: got ${JSON.stringify(idem1)}`);
}

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────
head("FINAL SUMMARY");

const pctPassed = Math.round((passed / totalTests) * 100);
console.log(`  Tests passed: ${C.B}${passed}/${totalTests} (${pctPassed}%)${C.R}`);
console.log(`  Compositions: ${C.B}${actions.length} messages${C.R}, avg score ${C.B}${avgCompose}/9${C.R}`);
console.log();

if (pctPassed >= 90) console.log(`  ${C.G}${C.B}EXCELLENT — Ready for submission${C.R}`);
else if (pctPassed >= 70) console.log(`  ${C.Y}${C.B}GOOD — Minor improvements needed${C.R}`);
else console.log(`  ${C.RED}${C.B}NEEDS WORK${C.R}`);

console.log();
