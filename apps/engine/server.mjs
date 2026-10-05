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
import { createRequire } from "node:module";
import * as box from "../web/protocol.js";

// Same WASM signer the browsers run; the engine uses it only for the arbiter's share.
const frost = createRequire(import.meta.url)("./signer/aegis_signer.js");

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
  if (deal.mode === "self") return startSelfPayout(deal, action, [s1, s2], to);
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

// ======================================================================
// Self-custody mode: buyer and seller keep their FROST shares in their own browsers.
// The engine holds only the arbiter's share, relays public round-1 packages, and relays
// round-2 packages as sealed boxes it cannot open (apps/web/protocol.js).
// ======================================================================
const ID = { buyer: 1, seller: 2, arbiter: 3 };
const ROLE_OF = { 1: "buyer", 2: "seller", 3: "arbiter" };
const J = JSON.parse, S = JSON.stringify;
const arbiterFile = (id) => join(dealDir(id), "arbiter-secret.json");
const loadArb = (id) => (existsSync(arbiterFile(id)) ? J(readFileSync(arbiterFile(id), "utf8")) : {});
const saveArb = (id, a) => writeFileSync(arbiterFile(id), S(a));

// Serialize every mutation of one deal: requests await each other instead of racing.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

async function createSelfDeal({ title, priceZec, terms, sellerAddress }) {
  const id = newId();
  mkdirSync(dealDir(id), { recursive: true });
  const bk = await box.newBoxKey();
  const r1 = J(frost.dkgPart1(ID.arbiter));
  saveArb(id, { boxPrivate: bk.privateJwk, secret1: r1.secret });
  const deal = {
    id, title, priceZec, terms, network: "test", mode: "self",
    addresses: { seller: sellerAddress, buyer: null },
    tokens: { buyer: token(), seller: token(), arbiter: token() },
    status: "setting_up", approvals: {}, txs: [], createdAt: new Date().toISOString(),
    keys: { boxKeys: { arbiter: bk.publicKey }, round1: { 3: r1.package }, round2: { 1: {}, 2: {}, 3: {} }, done: {} },
  };
  save(deal);
  return deal;
}

// Arbiter's side of the ceremony, advanced whenever new messages arrive.
async function arbiterAdvance(deal) {
  const k = deal.keys, a = loadArb(deal.id);
  const haveAll1 = [1, 2, 3].every((n) => k.round1[n]);
  if (haveAll1 && !a.secret2 && !a.keyPackage) {
    const others = { 1: k.round1[1], 2: k.round1[2] };
    const p2 = J(frost.dkgPart2(S(a.secret1), S(others)));
    for (const n of [1, 2]) k.round2[n][3] = await box.seal(k.boxKeys[ROLE_OF[n]], S(p2.packages[n]));
    a.secret2 = p2.secret;
    saveArb(deal.id, a);
  }
  if (a.secret2 && !a.keyPackage && k.round2[3][1] && k.round2[3][2]) {
    const mine = {};
    for (const n of [1, 2]) mine[n] = J(await box.open(a.boxPrivate, k.round2[3][n]));
    const r3 = J(frost.dkgPart3(S(a.secret2), S({ 1: k.round1[1], 2: k.round1[2] }), S(mine)));
    a.keyPackage = r3.keyPackage;
    a.publicKeyPackage = r3.publicKeyPackage;
    delete a.secret1; delete a.secret2; // round secrets are single-use
    saveArb(deal.id, a);
    k.done.arbiter = r3.groupKey;
    k.publicKeyPackage = r3.publicKeyPackage;
  }
  const g = k.done;
  if (g.buyer && g.seller && g.arbiter && !deal.escrow && !k.finishing) {
    if (!(g.buyer === g.seller && g.seller === g.arbiter)) {
      deal.status = "setup_failed";
      deal.setupError = "The three parties computed different keys. Nothing was funded; start a new deal.";
      return;
    }
    k.finishing = true;
    writeFileSync(join(dealDir(deal.id), "group.hex"), g.arbiter + "\n");
    const job = enqueue(deal, "setup", async (job) => {
      await step(job, deal, ["escrow"]);
      await step(job, deal, ["wallet"]);
      await withLock(deal.id, async () => {
        const d = load(deal.id);
        d.escrow = J(readFileSync(join(dealDir(deal.id), "escrow.json"), "utf8"));
        d.groupKey = g.arbiter;
        d.status = "awaiting_funds";
        save(d);
      });
    });
    deal.setupJob = job.id;
  }
}

async function keysMessage(deal, role, b) {
  const k = deal.keys, me = ID[role];
  if (role === "arbiter") throw new Error("The arbiter's share is handled by the engine.");
  if (b.stage === "round1") {
    if (k.round1[me]) throw new Error("Round 1 already received from you.");
    if (!b.package || !b.boxKey) throw new Error("Missing round-1 package or box key.");
    k.round1[me] = b.package;
    k.boxKeys[role] = b.boxKey;
  } else if (b.stage === "round2") {
    for (const n of [1, 2, 3]) {
      if (n === me) continue;
      if (!b.packages?.[n]?.ct) throw new Error("Round-2 packages must be sealed boxes.");
      k.round2[n][me] = b.packages[n];
    }
  } else if (b.stage === "done") {
    if (!/^[0-9a-f]{64}$/.test(b.groupKey || "")) throw new Error("Bad group key.");
    k.done[role] = b.groupKey;
  } else throw new Error("Unknown stage.");
  await arbiterAdvance(deal);
  save(deal);
}

function keysView(deal, role) {
  const k = deal.keys, me = ID[role];
  return {
    round1: k.round1, boxKeys: k.boxKeys,
    round2ForMe: k.round2[me] || {},
    done: Object.keys(k.done),
    fingerprints: k.boxKeys,
  };
}

// ---------- self-custody signing ----------
function outputToRecipient(inspectTxt, to) {
  // "- Output: 10000000 zatoshis to utest1…"
  const m = [...inspectTxt.matchAll(/Output: (\d+) zatoshis to (\S+)/g)].find((x) => x[2] === to);
  return m ? Number(m[1]) : null;
}

function startSelfPayout(deal, action, signers, to) {
  deal.status = "paying_out";
  save(deal);
  return enqueue(deal, action, async (job) => {
    await step(job, deal, ["wallet"]);
    const out = await step(job, deal, ["prepare", to, "max", `Aegis Gate ${action}: ${deal.title}`.slice(0, 500)]);
    const txdir = (out.match(/^TXDIR=(.+)$/m) || [])[1]?.trim();
    if (!txdir) throw new Error("prepare did not report a transaction directory");
    const winDir = txdir.replace(/^\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`);
    const request = J(readFileSync(join(winDir, "request.json"), "utf8"));
    const inspect = readFileSync(join(winDir, "inspect.txt"), "utf8");
    await withLock(deal.id, async () => {
      const d = load(deal.id);
      d.signing = {
        id: newId(), action, signers, to, txdir: winDir,
        amountZats: outputToRecipient(inspect, to), sighash: request.sighash, spends: request.spends,
        commitments: {}, packages: null, shares: {},
      };
      d.status = "signing";
      if (signers.includes("arbiter")) arbiterCommit(d);
      save(d);
    });
  });
}

function arbiterCommit(d) {
  const a = loadArb(d.id);
  const rounds = d.signing.spends.map(() => J(frost.signCommit(S(a.keyPackage))));
  a.nonces = { session: d.signing.id, list: rounds.map((r) => r.nonces) };
  saveArb(d.id, a);
  d.signing.commitments.arbiter = rounds.map((r) => r.commitments);
}

function maybeBuildPackages(d) {
  const sg = d.signing;
  if (sg.packages || !sg.signers.every((r) => sg.commitments[r])) return;
  sg.packages = sg.spends.map((_, i) => frost.signingPackage(S(Object.fromEntries(sg.signers.map((r) => [ID[r], sg.commitments[r][i]]))), sg.sighash));
  if (sg.signers.includes("arbiter")) {
    const a = loadArb(d.id);
    if (a.nonces?.session !== sg.id) throw new Error("Arbiter nonces don't match this signing session.");
    sg.shares.arbiter = sg.spends.map((s, i) => J(frost.signShare(sg.packages[i], S(a.nonces.list[i]), S(a.keyPackage), s.alpha)));
    delete a.nonces; // nonces are single-use
    saveArb(d.id, a);
  }
}

function maybeFinishSigning(d) {
  const sg = d.signing;
  if (!sg.packages || !sg.signers.every((r) => sg.shares[r])) return null;
  const pkp = d.keys.publicKeyPackage;
  const sigs = sg.spends.map((s, i) => {
    const shares = Object.fromEntries(sg.signers.map((r) => [ID[r], sg.shares[r][i]]));
    const sig = frost.aggregate(sg.packages[i], S(shares), S(pkp), s.alpha);
    if (!frost.verify(S(pkp), s.alpha, sg.sighash, sig)) throw new Error("Aggregated signature failed verification.");
    return { pool: s.pool, index: s.index, signature: sig };
  });
  writeFileSync(join(sg.txdir, "signatures.json"), S(sigs));
  d.status = "paying_out";
  const { action, signers, to, txdir } = sg;
  return enqueue(d, action, async (job) => {
    const out = await step(job, d, ["finish", txdir.replace(/^([A-Z]):\//, (_, x) => `/${x.toLowerCase()}/`)]);
    const txid = (out.match(/^[0-9a-f]{64}$/gm) || []).pop();
    await withLock(d.id, async () => {
      const x = load(d.id);
      x.txs.push({ action, txid, signers, to, at: new Date().toISOString(), selfCustody: true });
      x.status = action === "release" ? "released" : "refunded";
      x.approvals = {};
      delete x.signing;
      save(x);
    });
  });
}

function signMessage(d, role, b) {
  const sg = d.signing;
  if (!sg || d.status !== "signing") throw new Error("There's nothing to sign right now.");
  if (!sg.signers.includes(role) || role === "arbiter") throw new Error("You're not one of the two signers for this payout.");
  if (b.session !== sg.id) throw new Error("That signing session has ended. Reload the page.");
  const n = sg.spends.length;
  if (b.stage === "commit") {
    if (!Array.isArray(b.commitments) || b.commitments.length !== n) throw new Error("Expected one commitment per spend.");
    if (sg.commitments[role]) throw new Error("Commitments already received.");
    sg.commitments[role] = b.commitments;
    maybeBuildPackages(d);
    return null;
  }
  if (b.stage === "share") {
    if (!sg.packages) throw new Error("Waiting for the other signer's commitment.");
    if (!Array.isArray(b.shares) || b.shares.length !== n) throw new Error("Expected one signature share per spend.");
    sg.shares[role] = b.shares;
    return maybeFinishSigning(d);
  }
  throw new Error("Unknown signing stage.");
}

function signingView(d, role) {
  const sg = d.signing;
  if (!sg) return null;
  return {
    id: sg.id, action: sg.action, signers: sg.signers, to: sg.to, amountZats: sg.amountZats,
    sighash: sg.sighash, spends: sg.spends, packages: sg.packages,
    committed: Object.keys(sg.commitments), shared: Object.keys(sg.shares),
    mine: sg.signers.includes(role) && role !== "arbiter",
  };
}

// ---------- views ----------
function view(deal, role) {
  const v = {
    id: deal.id, title: deal.title, priceZec: deal.priceZec, terms: deal.terms, network: deal.network,
    status: deal.status, createdAt: deal.createdAt, role,
    escrow: deal.escrow ? { address: deal.escrow.address, ufvk: deal.escrow.ufvk } : null,
    balance: deal.balance || null, approvals: deal.approvals, txs: deal.txs,
    addresses: { seller: !!deal.addresses.seller, buyer: !!deal.addresses.buyer },
    setupJob: deal.setupJob, mode: deal.mode || "engine", setupError: deal.setupError || null,
  };
  if (deal.mode === "self") {
    v.keys = keysView(deal, role);
    v.signing = signingView(deal, role);
    // Signers see the real payout addresses so their browser can check where money goes.
    v.payoutAddresses = deal.addresses;
  }
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
      const input = { title, priceZec, terms: String(b.terms || "").slice(0, 2000), sellerAddress: b.sellerAddress.trim() };
      const d = b.selfCustody ? await createSelfDeal(input) : createDeal(input);
      return send(res, 201, { id: d.id, seller: d.tokens.seller, buyer: d.tokens.buyer, setupJob: d.setupJob || null, mode: d.mode || "engine" });
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

      if (parts[3] === "keys" && deal.mode === "self") {
        if (req.method === "GET") return send(res, 200, keysView(deal, role));
        const b = await readBody(req);
        const d = await withLock(deal.id, async () => { const x = load(deal.id); await keysMessage(x, role, b); return x; });
        return send(res, 200, view(d, role));
      }

      if (parts[3] === "sign" && deal.mode === "self" && req.method === "POST") {
        const b = await readBody(req);
        const r = await withLock(deal.id, async () => { const x = load(deal.id); const job = signMessage(x, role, b); save(x); return { x, job }; });
        return send(res, 200, { ...view(load(deal.id), role), job: r.job && r.job.id });
      }

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
        const job = await withLock(deal.id, async () => approve(load(deal.id), role, b.action));
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
  if (d && ["paying_out", "signing"].includes(d.status)) { d.status = d.disputedBy ? "disputed" : "funded"; d.approvals = {}; delete d.signing; save(d); }
  if (d && d.status === "setting_up" && !d.escrow && d.mode !== "self") { d.status = "setup_failed"; save(d); }
  if (d && d.mode === "self" && d.keys?.finishing && !d.escrow) { delete d.keys.finishing; save(d); }
}

server.listen(PORT, "127.0.0.1", () => console.log(`Aegis Gate engine on http://127.0.0.1:${PORT}`));
