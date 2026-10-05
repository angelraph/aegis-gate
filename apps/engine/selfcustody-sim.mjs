// Plays the buyer's and seller's browsers against an engine, using the same WASM signer
// and sealed boxes the website uses. Proves the self-custody protocol end to end.
//
//   node apps/engine/selfcustody-sim.mjs setup  <engine> <sellerAddr> <buyerAddr>
//   node apps/engine/selfcustody-sim.mjs payout <engine> <dealId> <action>
//
// State (each party's secrets, as a browser would keep them) lives in .sim-<dealId>.json.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as box from "../web/protocol.js";

const frost = createRequire(import.meta.url)("./signer/aegis_signer.js");
const J = JSON.parse, S = JSON.stringify;
const ID = { buyer: 1, seller: 2, arbiter: 3 };
const [, , cmd, engine, a1, a2, a3] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateFile = (id) => `.sim-${id}.json`;

async function api(path, body) {
  const r = await fetch(engine + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: S(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}

// One party's browser through the key ceremony. `st` is that browser's local storage.
async function partyStep(deal, role, tok, st) {
  const me = ID[role];
  const k = await api(`/api/deals/${deal}/keys?t=${tok}`);
  if (!st.round1Sent) {
    const bk = await box.newBoxKey();
    const r1 = J(frost.dkgPart1(me));
    Object.assign(st, { boxPrivate: bk.privateJwk, secret1: r1.secret, round1Sent: true });
    await api(`/api/deals/${deal}/keys?t=${tok}`, { stage: "round1", package: r1.package, boxKey: bk.publicKey });
    return "round1 sent";
  }
  const all1 = [1, 2, 3].every((n) => k.round1[n]);
  if (all1 && !st.round2Sent) {
    const others = Object.fromEntries([1, 2, 3].filter((n) => n !== me).map((n) => [n, k.round1[n]]));
    const p2 = J(frost.dkgPart2(S(st.secret1), S(others)));
    const sealed = {};
    for (const n of Object.keys(p2.packages)) sealed[n] = await box.seal(k.boxKeys[{ 1: "buyer", 2: "seller", 3: "arbiter" }[n]], S(p2.packages[n]));
    Object.assign(st, { secret2: p2.secret, round2Sent: true, others });
    await api(`/api/deals/${deal}/keys?t=${tok}`, { stage: "round2", packages: sealed });
    return "round2 sent (sealed)";
  }
  const got = k.round2ForMe;
  const need = [1, 2, 3].filter((n) => n !== me);
  if (st.round2Sent && !st.keyPackage && need.every((n) => got[n])) {
    const mine = {};
    for (const n of need) mine[n] = J(await box.open(st.boxPrivate, got[n]));
    const r3 = J(frost.dkgPart3(S(st.secret2), S(st.others), S(mine)));
    Object.assign(st, { keyPackage: r3.keyPackage, groupKey: r3.groupKey });
    delete st.secret1; delete st.secret2;
    await api(`/api/deals/${deal}/keys?t=${tok}`, { stage: "done", groupKey: r3.groupKey });
    return "key ready: " + r3.groupKey.slice(0, 16) + "…";
  }
  return "waiting";
}

if (cmd === "setup") {
  const d = await api("/api/deals", { title: "Self-custody test deal", priceZec: 0.01, terms: "simulator", sellerAddress: a1, selfCustody: true });
  const st = { id: d.id, tokens: { buyer: d.buyer, seller: d.seller }, buyer: {}, seller: {} };
  console.log("deal", d.id, "mode", d.mode);
  for (let i = 0; i < 40; i++) {
    for (const role of ["seller", "buyer"]) console.log(role.padEnd(6), await partyStep(d.id, role, st.tokens[role], st[role]));
    const v = await api(`/api/deals/${d.id}?t=${st.tokens.seller}`);
    if (v.escrow) { console.log("ESCROW", v.escrow.address); break; }
    await sleep(2500);
  }
  await api(`/api/deals/${d.id}/address?t=${st.tokens.buyer}`, { address: a2 });
  writeFileSync(stateFile(d.id), S(st));
  const v = await api(`/api/deals/${d.id}?t=${st.tokens.buyer}`);
  console.log("status", v.status, "| browsers agree:", st.buyer.groupKey === st.seller.groupKey, "| keys done:", v.keys.done.join(","));
}

if (cmd === "payout") {
  const id = a1, action = a2;
  const st = J(readFileSync(stateFile(id), "utf8"));
  const signers = action === "release" ? ["buyer", "seller"] : ["buyer", "seller"];
  for (const role of signers) {
    const r = await api(`/api/deals/${id}/approve?t=${st.tokens[role]}`, { action });
    console.log(role, "approved; status", r.status);
  }
  for (let i = 0; i < 120; i++) {
    const v = await api(`/api/deals/${id}?t=${st.tokens.buyer}`);
    if (["released", "refunded"].includes(v.status)) { console.log("DONE", v.status, v.txs.at(-1)); break; }
    const sg = v.signing;
    if (v.status === "signing" && sg) {
      for (const role of signers) {
        const p = st[role];
        // A real browser shows sg.to and sg.amountZats to the person before this point.
        if (!sg.committed.includes(role)) {
          const rounds = sg.spends.map(() => J(frost.signCommit(S(p.keyPackage))));
          p.nonces = { session: sg.id, list: rounds.map((r) => r.nonces) };
          await api(`/api/deals/${id}/sign?t=${st.tokens[role]}`, { stage: "commit", session: sg.id, commitments: rounds.map((r) => r.commitments) });
          console.log(role, "committed; pays", sg.amountZats, "zats to", sg.to.slice(0, 20) + "…");
        } else if (sg.packages && !sg.shared.includes(role) && p.nonces?.session === sg.id) {
          const shares = sg.spends.map((s, i) => J(frost.signShare(sg.packages[i], S(p.nonces.list[i]), S(p.keyPackage), s.alpha)));
          delete p.nonces;
          await api(`/api/deals/${id}/sign?t=${st.tokens[role]}`, { stage: "share", session: sg.id, shares });
          console.log(role, "signed");
        }
      }
      writeFileSync(stateFile(id), S(st));
    }
    await sleep(3000);
  }
}
