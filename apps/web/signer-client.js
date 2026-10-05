// Aegis Gate browser signer: keeps this person's FROST key share in this browser.
//
// The share never leaves the device. The engine sees public round-1 commitments, sealed
// round-2 boxes it cannot open, and signature shares, which reveal nothing about the key.

import init, * as frost from "/signer/aegis_signer.js";
import * as box from "/protocol.js";

const ID = { buyer: 1, seller: 2, arbiter: 3 };
const ROLE = { 1: "buyer", 2: "seller", 3: "arbiter" };
const J = JSON.parse, S = JSON.stringify;
let ready = null;
export const load = () => (ready ??= init());

const keyName = (deal, role) => `aegis-gate:key:${deal}:${role}`;
function readStore(deal, role) {
  try { return J(localStorage.getItem(keyName(deal, role)) || "{}"); } catch { return {}; }
}
function writeStore(deal, role, st) {
  // If storage is blocked we can't keep a share safely; surface that instead of continuing.
  localStorage.setItem(keyName(deal, role), S(st));
}

export function hasKey(deal, role) { return !!readStore(deal, role).keyPackage; }
export function inProgress(deal, role) { const s = readStore(deal, role); return !!s.round1Sent && !s.keyPackage; }

/** Advance this browser's part of the key ceremony by one step. Returns a status word. */
export async function ceremonyStep(api, deal, role, tq) {
  await load();
  const me = ID[role];
  const st = readStore(deal, role);
  if (st.keyPackage) return "ready";
  const k = await api(`/api/deals/${deal}/keys?t=${tq}`);
  if (!st.round1Sent) {
    const bk = await box.newBoxKey();
    const r1 = J(frost.dkgPart1(me));
    Object.assign(st, { boxPrivate: bk.privateJwk, boxPublic: bk.publicKey, secret1: r1.secret, round1Sent: true });
    writeStore(deal, role, st);
    await api(`/api/deals/${deal}/keys?t=${tq}`, { method: "POST", body: S({ stage: "round1", package: r1.package, boxKey: bk.publicKey }) });
    return "round1";
  }
  if (!st.round2Sent) {
    if (![1, 2, 3].every((n) => k.round1[n])) return "waiting-others";
    const others = Object.fromEntries([1, 2, 3].filter((n) => n !== me).map((n) => [n, k.round1[n]]));
    const p2 = J(frost.dkgPart2(S(st.secret1), S(others)));
    const sealed = {};
    for (const n of Object.keys(p2.packages)) sealed[n] = await box.seal(k.boxKeys[ROLE[n]], S(p2.packages[n]));
    Object.assign(st, { secret2: p2.secret, others, round2Sent: true });
    delete st.secret1;
    writeStore(deal, role, st);
    await api(`/api/deals/${deal}/keys?t=${tq}`, { method: "POST", body: S({ stage: "round2", packages: sealed }) });
    return "round2";
  }
  const need = [1, 2, 3].filter((n) => n !== me);
  if (!need.every((n) => k.round2ForMe[n])) return "waiting-others";
  const mine = {};
  for (const n of need) mine[n] = J(await box.open(st.boxPrivate, k.round2ForMe[n]));
  const r3 = J(frost.dkgPart3(S(st.secret2), S(st.others), S(mine)));
  const done = { keyPackage: r3.keyPackage, groupKey: r3.groupKey, boxPublic: st.boxPublic, createdAt: new Date().toISOString() };
  writeStore(deal, role, done);
  await api(`/api/deals/${deal}/keys?t=${tq}`, { method: "POST", body: S({ stage: "done", groupKey: r3.groupKey }) });
  return "ready";
}

/**
 * Review a payout entirely on this device. Fetches the transaction itself (not a summary),
 * re-derives the escrow from this browser's own group key, checks every output against its
 * commitments and ciphertext, recomputes the sighash, and applies the signing policy.
 * Returns the review; throws if the payout can't be signed.
 */
export async function reviewSession(api, deal, role, tq, sg, expectedTo, network = "test") {
  await load();
  const st = readStore(deal, role);
  if (!st.keyPackage || !st.groupKey) throw new Error("This browser doesn't hold your key for this deal.");
  if (!expectedTo) throw new Error("No agreed payout address for this outcome. Your browser refused to sign.");
  const tx = await api(`/api/deals/${deal}/pczt?t=${tq}`);
  if (tx.session !== sg.id) throw new Error("The signing session changed. Reload the page.");
  let r;
  try { r = J(frost.reviewPayout(tx.pczt, st.groupKey, deal, network, expectedTo)); }
  catch (e) { throw new Error("Your browser couldn't verify this transaction, so it refused to sign. " + (e.message || e)); }
  if (!r.ok) throw new Error("Your browser refused to sign: " + r.reasons.join("; ") + ".");
  if (r.review.sighash !== sg.sighash) throw new Error("The engine described a different transaction than the one it sent. Your browser refused to sign.");
  return r;
}

/**
 * Take part in a signing session after reviewing it. Only the sighash and randomizers this
 * browser computed itself are ever signed.
 */
export async function signStep(api, deal, role, tq, sg, expectedTo, network = "test") {
  await load();
  if (!sg || !sg.mine) return { state: "not-signer" };
  const st = readStore(deal, role);
  if (!st.keyPackage) throw new Error("This browser doesn't hold your key for this deal.");
  const verified = await reviewSession(api, deal, role, tq, sg, expectedTo, network);
  const mySpends = verified.review.spends;
  if (mySpends.length !== sg.spends.length) throw new Error("Spend count doesn't match the transaction. Your browser refused to sign.");

  if (!sg.committed.includes(role)) {
    const rounds = mySpends.map(() => J(frost.signCommit(S(st.keyPackage))));
    st.nonces = { session: sg.id, list: rounds.map((r) => r.nonces) };
    writeStore(deal, role, st);
    await api(`/api/deals/${deal}/sign?t=${tq}`, { method: "POST", body: S({ stage: "commit", session: sg.id, commitments: rounds.map((r) => r.commitments) }) });
    return { state: "committed", review: verified };
  }
  if (sg.packages && !sg.shared.includes(role)) {
    if (st.nonces?.session !== sg.id) throw new Error("This signing session started in another browser tab or device.");
    for (const pkg of sg.packages) {
      if (J(pkg).message !== verified.review.sighash) throw new Error("The signing request doesn't match the transaction you reviewed. Your browser refused to sign.");
    }
    const shares = mySpends.map((spend, i) => J(frost.signShare(sg.packages[i], S(st.nonces.list[i]), S(st.keyPackage), spend.alpha)));
    delete st.nonces; // nonces must never be reused
    writeStore(deal, role, st);
    await api(`/api/deals/${deal}/sign?t=${tq}`, { method: "POST", body: S({ stage: "share", session: sg.id, shares }) });
    return { state: "signed", review: verified };
  }
  return { state: sg.shared.includes(role) ? "signed" : "waiting-others", review: verified };
}

/** A backup file of this browser's key share for the deal. */
export function backupBlob(deal, role) {
  const st = readStore(deal, role);
  if (!st.keyPackage) return null;
  const doc = { kind: "aegis-gate-key-share", version: 1, deal, role, groupKey: st.groupKey, keyPackage: st.keyPackage, createdAt: st.createdAt };
  return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
}

/** Restore a share from a backup file. Checks it belongs to this deal and role. */
export async function restore(deal, role, file, expectedGroupKey) {
  const doc = J(await file.text());
  if (doc.kind !== "aegis-gate-key-share" || doc.deal !== deal || doc.role !== role) throw new Error("That backup is for a different deal or role.");
  if (expectedGroupKey && doc.groupKey !== expectedGroupKey) throw new Error("That backup doesn't match this escrow's key.");
  writeStore(deal, role, { keyPackage: doc.keyPackage, groupKey: doc.groupKey, createdAt: doc.createdAt });
}

export async function myFingerprint(boxKey) { return box.fingerprint(boxKey); }

/**
 * The deal security code: a short hash of all three parties' box keys plus the group key
 * this browser computed. Buyer and seller compare it out of band before paying. If the
 * relay swapped a key, or showed the two of them different keys, the codes differ.
 * Also checks this browser's own box key arrived unaltered.
 */
export async function securityCode(deal, role, boxKeys) {
  const st = readStore(deal, role);
  if (!st.groupKey || !boxKeys?.buyer || !boxKeys?.seller || !boxKeys?.arbiter) return null;
  const ownIntact = !st.boxPublic || boxKeys[role] === st.boxPublic;
  const data = new TextEncoder().encode(["aegis-gate/deal-code/v1", deal, boxKeys.buyer, boxKeys.seller, boxKeys.arbiter, st.groupKey].join("|"));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const words = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join("").match(/.{4}/g).join(" ");
  return { code: words, ownIntact };
}
