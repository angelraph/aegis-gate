// Aegis Gate engine: deals, approvals and the real FROST escrow pipeline.
//
// Every action runs poc/escrow.sh with a per-deal working directory, so the engine adds
// no cryptography of its own. Each party gets a secret link token. A payout runs only
// after two different parties approve the same action, and the two approvers are the
// FROST signers.
//
// Testnet build: all three FROST signers run on this engine. Moving each signer into its
// owner's browser is the next milestone (see docs/THREAT_MODEL.md).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "poc", "escrow.sh");
const SHARED = join(ROOT, "poc", ".work");
const DEALS = process.env.AEGIS_DEALS || join(ROOT, "poc", ".deals");
const PORT = Number(process.env.PORT || 8787);
const BASH = process.env.AEGIS_BASH || "C:\\Program Files\\Git\\bin\\bash.exe";
const DEVTOOL = join(process.env.AEGIS_BIN || "", "zcash-devtool.exe");
const ROLES = ["buyer", "seller", "arbiter"];
const ACTIONS = {
  release: { to: "seller", label: "Release to the seller" },
  refund: { to: "buyer", label: "Refund to the buyer" },
};

mkdirSync(DEALS, { recursive: true });

// The operator (arbiter) key. Kept in the deals folder so it survives restarts.
const ADMIN_FILE = join(DEALS, ".admin-key");
if (!existsSync(ADMIN_FILE)) writeFileSync(ADMIN_FILE, randomBytes(18).toString("base64url"));
const ADMIN_KEY = readFileSync(ADMIN_FILE, "utf8").trim();

// ---------- deal storage ----------
const dealDir = (id) => join(DEALS, id);
const dealFile = (id) => join(dealDir(id), "deal.json");
const load = (id) => (existsSync(dealFile(id)) ? JSON.parse(readFileSync(dealFile(id), "utf8")) : null);
const save = (d) => writeFileSync(dealFile(d.id), JSON.stringify(d, null, 2));
const token = () => randomBytes(18).toString("base64url");
const newId = () => randomBytes(5).toString("hex");

function roleFor(deal, t) {
  if (!t) return null;
  for (const r of ROLES) {
    const a = Buffer.from(deal.tokens[r]);
    const b = Buffer.from(String(t));
    if (a.length === b.length && timingSafeEqual(a, b)) return r;
  }
  return null;
}

// ---------- job queue: one escrow operation at a time ----------
let queue = Promise.resolve();
const jobs = new Map();

function runScript(deal, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(BASH, [SCRIPT, ...args], {
      env: { ...process.env, AEGIS_WORK: dealDir(deal.id), AEGIS_SHARED: SHARED, AEGIS_DEAL: deal.id, ...extraEnv },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") }));
  });
}

function enqueue(deal, kind, fn) {
  const id = newId();
  const job = { id, deal: deal.id, kind, state: "queued", log: "", started: Date.now() };
  jobs.set(id, job);
  queue = queue.then(async () => {
    job.state = "running";
    try {
      await fn(job);
      job.state = job.state === "running" ? "done" : job.state;
    } catch (e) {
      job.state = "failed";
      job.log += `\n${e.message}`;
    }
  });
  return job;
}

async function step(job, deal, args, env) {
  const r = await runScript(deal, args, env);
  job.log += r.out.split("\n").filter((l) => !/ INFO /.test(l)).join("\n");
  if (r.code !== 0) throw new Error(`step "${args[0]}" failed (exit ${r.code})`);
  return r.out;
}

// ---------- chain reads ----------
function devtool(deal, args) {
  return new Promise((resolve) => {
    const child = spawn(DEVTOOL, ["wallet", "-w", join(dealDir(deal.id), "wallet"), ...args], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function refreshBalance(deal) {
  if (!deal.escrow) return deal;
  await devtool(deal, ["sync"]);
  const r = await devtool(deal, ["balance", "--json"]);
  try {
    const b = JSON.parse(r.out.trim().split("\n").pop());
    deal.balance = { total: b.total, spendable: b.ironwood_spendable + b.orchard_spendable, tip: b.chain_tip_height, at: Date.now() };
    if (deal.status === "awaiting_funds" && deal.balance.total > 0) deal.status = "funded";
    save(deal);
  } catch { /* keep the last known balance */ }
  return deal;
}

// ---------- operations ----------
function createDeal({ title, priceZec, terms, sellerAddress }) {
  const id = newId();
  mkdirSync(dealDir(id), { recursive: true });
  const deal = {
    id, title, priceZec, terms, network: "test",
    addresses: { seller: sellerAddress, buyer: null },
    tokens: { buyer: token(), seller: token(), arbiter: token() },
    status: "setting_up", approvals: {}, txs: [], createdAt: new Date().toISOString(),
  };
  save(deal);
  const job = enqueue(deal, "setup", async (job) => {
    await step(job, deal, ["certs"]);
    await step(job, deal, ["relay"]);
    await step(job, deal, ["parties"]);
    await step(job, deal, ["dkg"]);
    await step(job, deal, ["escrow"]);
    await step(job, deal, ["wallet"]);
    const d = load(id);
    d.escrow = JSON.parse(readFileSync(join(dealDir(id), "escrow.json"), "utf8"));
    d.groupKey = readFileSync(join(dealDir(id), "group.hex"), "utf8").trim();
    d.status = "awaiting_funds";
    save(d);
  });
  deal.setupJob = job.id;
  save(deal);
  return deal;
}

function approve(deal, role, action) {
  if (!ACTIONS[action]) throw new Error("Unknown action. Use release or refund.");
  if (!["funded", "disputed"].includes(deal.status)) throw new Error("The escrow isn't funded yet.");
  if (!deal.balance || deal.balance.spendable <= 0) {
    throw new Error("The payment has arrived but isn't confirmed yet. Zcash wallets wait about 10 blocks (around 12 minutes) before funds can move. Try again shortly.");
  }
  const to = deal.addresses[ACTIONS[action].to];
  if (!to) throw new Error(`The ${ACTIONS[action].to} hasn't added a payout address yet.`);
  // One live approval per role: a new choice replaces the old one.
  deal.approvals[role] = action;
  const agreeing = ROLES.filter((r) => deal.approvals[r] === action);
  save(deal);
  if (agreeing.length < 2) return null;

  const [s1, s2] = agreeing;
  deal.status = "paying_out";
  save(deal);
  return enqueue(deal, action, async (job) => {
    await step(job, deal, ["wallet"]);
    const out = await step(job, deal, ["payout", to, "max", s1, s2, `Aegis Gate ${action}: ${deal.title}`.slice(0, 500)]);
    const txid = (out.match(/^[0-9a-f]{64}$/gm) || []).pop();
    const d = load(deal.id);
    d.txs.push({ action, txid, signers: [s1, s2], to, at: new Date().toISOString() });
    d.status = action === "release" ? "released" : "refunded";
    d.approvals = {};
    save(d);
  });
}

// ---------- views ----------
function view(deal, role) {
  const v = {
    id: deal.id, title: deal.title, priceZec: deal.priceZec, terms: deal.terms, network: deal.network,
    status: deal.status, createdAt: deal.createdAt, role,
    escrow: deal.escrow ? { address: deal.escrow.address, ufvk: deal.escrow.ufvk } : null,
    balance: deal.balance || null, approvals: deal.approvals, txs: deal.txs,
    addresses: { seller: !!deal.addresses.seller, buyer: !!deal.addresses.buyer },
    setupJob: deal.setupJob,
  };
  if (role === "seller") v.invite = { buyer: deal.tokens.buyer };
  if (role === "arbiter") v.addressesFull = deal.addresses;
  return v;
}

// ---------- HTTP ----------
function send(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error("Request too large."); }
  return s ? JSON.parse(s) : {};
}
const isAddress = (a) => typeof a === "string" && /^(utest1|zutest1|u1|zu1)[0-9a-z]{40,}$/.test(a.trim());

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const t = url.searchParams.get("t");
  try {
    if (parts[0] !== "api") return send(res, 404, { error: "Not found." });

    if (parts[1] === "health") return send(res, 200, { ok: true, network: "test", deals: readdirSync(DEALS).length });

    if (parts[1] === "deals" && parts.length === 2 && req.method === "POST") {
      const b = await readBody(req);
      const title = String(b.title || "").trim().slice(0, 120);
      const priceZec = Number(b.priceZec);
      if (!title) return send(res, 400, { error: "Give the deal a name." });
      if (!(priceZec > 0 && priceZec < 21e6)) return send(res, 400, { error: "Enter a price above 0 ZEC." });
      if (!isAddress(b.sellerAddress)) return send(res, 400, { error: "Enter a shielded unified address for the seller payout (utest1…)." });
      const d = createDeal({ title, priceZec, terms: String(b.terms || "").slice(0, 2000), sellerAddress: b.sellerAddress.trim() });
      return send(res, 201, { id: d.id, seller: d.tokens.seller, buyer: d.tokens.buyer, setupJob: d.setupJob });
    }

    // Operator view: every deal with its arbiter link. Guarded by the admin key.
    if (parts[1] === "admin" && parts[2] === "deals") {
      const k = Buffer.from(String(url.searchParams.get("key") || ""));
      const want = Buffer.from(ADMIN_KEY);
      if (k.length !== want.length || !timingSafeEqual(k, want)) return send(res, 403, { error: "Wrong admin key." });
      const list = readdirSync(DEALS).map(load).filter(Boolean)
        .map((d) => ({ id: d.id, title: d.title, priceZec: d.priceZec, status: d.status, createdAt: d.createdAt, arbiter: d.tokens.arbiter, disputedBy: d.disputedBy || null }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { deals: list });
    }

    if (parts[1] === "jobs" && parts[2]) {
      const j = jobs.get(parts[2]);
      return j ? send(res, 200, { id: j.id, kind: j.kind, state: j.state, log: j.log.slice(-6000) }) : send(res, 404, { error: "Job not found." });
    }

    if (parts[1] === "deals" && parts[2]) {
      const deal = load(parts[2]);
      if (!deal) return send(res, 404, { error: "Deal not found." });
      const role = roleFor(deal, t);
      if (!role) return send(res, 403, { error: "This link isn't valid for this deal." });

      if (parts.length === 3 && req.method === "GET") return send(res, 200, view(deal, role));

      if (parts[3] === "refresh" && req.method === "POST") return send(res, 200, view(await refreshBalance(deal), role));

      if (parts[3] === "address" && req.method === "POST") {
        const b = await readBody(req);
        if (role === "arbiter") return send(res, 400, { error: "The arbiter doesn't receive payouts." });
        if (!isAddress(b.address)) return send(res, 400, { error: "Enter a shielded unified address (utest1…)." });
        deal.addresses[role] = b.address.trim();
        save(deal);
        return send(res, 200, view(deal, role));
      }

      if (parts[3] === "dispute" && req.method === "POST") {
        if (role === "arbiter") return send(res, 400, { error: "Only the buyer or seller can open a dispute." });
        if (deal.status !== "funded") return send(res, 400, { error: "Only a funded deal can be disputed." });
        deal.status = "disputed";
        deal.disputedBy = role;
        save(deal);
        return send(res, 200, view(deal, role));
      }

      if (parts[3] === "approve" && req.method === "POST") {
        const b = await readBody(req);
        await refreshBalance(deal);
        if (role === "arbiter" && deal.status !== "disputed") return send(res, 400, { error: "The arbiter signs only after a dispute is opened." });
        const job = approve(load(deal.id), role, b.action);
        return send(res, 200, { ...view(load(deal.id), role), job: job && job.id });
      }
    }
    return send(res, 404, { error: "Not found." });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

// Never let one bad request or a failed child process take the engine down.
process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "uncaught:", e));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "unhandled:", e));
server.requestTimeout = 120_000;
server.headersTimeout = 60_000;

// Jobs left "paying_out" by a restart are retried safely: the deal returns to its
// previous state so the two approvals can be submitted again.
for (const id of readdirSync(DEALS)) {
  const d = load(id);
  if (d && d.status === "paying_out") { d.status = d.disputedBy ? "disputed" : "funded"; d.approvals = {}; save(d); }
  if (d && d.status === "setting_up" && !d.escrow) { d.status = "setup_failed"; save(d); }
}

server.listen(PORT, "127.0.0.1", () => console.log(`Aegis Gate engine on http://127.0.0.1:${PORT}`));
