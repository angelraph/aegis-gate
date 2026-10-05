// Error-path suite: everything here must be refused, and no money may move.
//   node apps/engine/test-errors.mjs http://127.0.0.1:8788
import { createRequire } from "node:module";
import * as box from "../web/protocol.js";

const frost = createRequire(import.meta.url)("./signer/aegis_signer.js");
const engine = process.argv[2] || "http://127.0.0.1:8788";
const J = JSON.parse, S = JSON.stringify;
const ADDR = "utest10emcaclksqhdj35tvffg3z4l3rxljh027v9ky9z2r5jwuyne08kgr336sl9hq77wcjg2cm7jyhhpy3tcyrj2dvjldqdamw65er2hulk3frhw7q95p4e684sv7wahvg369me2v0l267658e92zh0g6cthxae3pjmz8c5mdm575xtk2w4p36a99pqhudqkunr5m8wv7ds2za69w2nevde";
let pass = 0, fail = 0;

async function call(path, body, method) {
  const r = await fetch(engine + path, body !== undefined ? { method: method || "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : S(body) } : {});
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function expectRefused(name, p, match) {
  const r = await p;
  const ok = r.status >= 400 && (!match || new RegExp(match, "i").test(r.body.error || ""));
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${r.status} ${r.body.error || ""}`);
}
async function expectOk(name, p) {
  const r = await p;
  const ok = r.status < 400;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${r.status}${ok ? "" : " " + r.body.error}`);
  return r.body;
}

// ---- input validation ----
await expectRefused("deal without a name", call("/api/deals", { title: "", priceZec: 1, sellerAddress: ADDR }), "name");
await expectRefused("negative price", call("/api/deals", { title: "x", priceZec: -1, sellerAddress: ADDR }), "price");
await expectRefused("transparent payout address", call("/api/deals", { title: "x", priceZec: 1, sellerAddress: "tmA5fCPmkg1111111111111111111111111" }), "shielded");
await expectRefused("malformed JSON body", call("/api/deals", "{not json"));
await expectRefused("oversized body", call("/api/deals", { title: "x".repeat(200000), priceZec: 1, sellerAddress: ADDR }));

const d = await expectOk("create a self-custody deal", call("/api/deals", { title: "Error-path deal", priceZec: 0.01, sellerAddress: ADDR, selfCustody: true }));
const tok = { buyer: d.buyer, seller: d.seller };

// ---- access control ----
await expectRefused("wrong link token", call(`/api/deals/${d.id}?t=not-a-token`, undefined), "isn't valid");
await expectRefused("no token", call(`/api/deals/${d.id}`, undefined), "isn't valid");
await expectRefused("unknown deal", call(`/api/deals/ffffffffff?t=${tok.buyer}`, undefined), "not found");
await expectRefused("admin list with wrong key", call(`/api/admin/deals?key=nope`, undefined), "admin");

// ---- money can't move early ----
await expectRefused("approve before keys exist", call(`/api/deals/${d.id}/approve?t=${tok.buyer}`, { action: "release" }), "funded");
await expectRefused("unknown action", call(`/api/deals/${d.id}/approve?t=${tok.buyer}`, { action: "steal" }));
await expectRefused("dispute before funding", call(`/api/deals/${d.id}/dispute?t=${tok.buyer}`, {}), "funded");
await expectRefused("sign with no session", call(`/api/deals/${d.id}/sign?t=${tok.buyer}`, { stage: "commit", session: "x", commitments: [] }), "nothing to sign");

// ---- key ceremony abuse ----
await expectRefused("round 2 sent in plain text", (async () => {
  const bk = await box.newBoxKey();
  await call(`/api/deals/${d.id}/keys?t=${tok.buyer}`, { stage: "round1", package: J(frost.dkgPart1(1)).package, boxKey: bk.publicKey });
  return call(`/api/deals/${d.id}/keys?t=${tok.buyer}`, { stage: "round2", packages: { 2: { secret: "plain" }, 3: { secret: "plain" } } });
})(), "sealed");
await expectRefused("round 1 sent twice", call(`/api/deals/${d.id}/keys?t=${tok.buyer}`, { stage: "round1", package: {}, boxKey: "x" }), "already");
await expectRefused("bad group key report", call(`/api/deals/${d.id}/keys?t=${tok.buyer}`, { stage: "done", groupKey: "zz" }), "group key");
await expectRefused("operator desk with a wrong key (second probe)", (async () => {
  const k = await call(`/api/admin/deals?key=wrong`, undefined); return k;
})());

// ---- escrow derivation consistency is enforced by the engine ----
// (a mismatched groupKey report from one party blocks the escrow; tested in the next deal)
const d2 = await expectOk("create second deal", call("/api/deals", { title: "Mismatch deal", priceZec: 0.01, sellerAddress: ADDR, selfCustody: true }));
await call(`/api/deals/${d2.id}/keys?t=${d2.seller}`, { stage: "done", groupKey: "11".repeat(32) });
await call(`/api/deals/${d2.id}/keys?t=${d2.buyer}`, { stage: "done", groupKey: "22".repeat(32) });
const v2 = (await call(`/api/deals/${d2.id}?t=${d2.seller}`, undefined)).body;
const blocked = !v2.escrow;
blocked ? pass++ : fail++;
console.log(`${blocked ? "PASS" : "FAIL"}  disagreeing key reports never produce an escrow  → status ${v2.status}`);

// ---- sealed boxes ----
const a = await box.newBoxKey(), b = await box.newBoxKey();
const sealed = await box.seal(a.publicKey, "share");
let wrongKey = false; try { await box.open(b.privateJwk, sealed); } catch { wrongKey = true; }
wrongKey ? pass++ : fail++; console.log(`${wrongKey ? "PASS" : "FAIL"}  sealed share can't be opened by anyone else`);

// ---- FROST ----
let single = false; try { frost.signingPackage(S({ 1: J(frost.signCommit(S(J(frost.dkgPart1(1)).secret))).commitments }), "00".repeat(32)); } catch { single = true; }
single ? pass++ : fail++; console.log(`${single ? "PASS" : "FAIL"}  one signer alone can't start a signature`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
