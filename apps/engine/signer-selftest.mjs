// Self-test for the WASM signer as JavaScript sees it: 3-party key ceremony, 2-of-3
// rerandomized signing, and a check of the result with the Rust consensus verifier.
//   node apps/engine/signer-selftest.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const s = createRequire(import.meta.url)("./signer/aegis_signer.js");
const J = JSON.parse, S = JSON.stringify;

// Key ceremony: each party only ever sees its own secrets.
const p1 = [1, 2, 3].map((n) => J(s.dkgPart1(n)));
const others = (me, f) => Object.fromEntries([1, 2, 3].filter((n) => n !== me).map((n) => [n, f(n)]));
const p2 = [1, 2, 3].map((me) => J(s.dkgPart2(S(p1[me - 1].secret), S(others(me, (n) => p1[n - 1].package)))));
const keys = [1, 2, 3].map((me) => J(s.dkgPart3(S(p2[me - 1].secret), S(others(me, (n) => p1[n - 1].package)), S(others(me, (n) => p2[n - 1].packages[me])))));
const group = keys[0].groupKey;
if (!keys.every((k) => k.groupKey === group)) throw new Error("group keys differ");

// A valid Pallas scalar as randomizer: small value, little-endian.
const alpha = "2a" + "00".repeat(31);
const msg = randomBytes(32).toString("hex");

function sign(pair) {
  const r = pair.map((n) => J(s.signCommit(S(keys[n - 1].keyPackage))));
  const sp = s.signingPackage(S(Object.fromEntries(pair.map((n, i) => [n, r[i].commitments]))), msg);
  const shares = Object.fromEntries(pair.map((n, i) => [n, J(s.signShare(sp, S(r[i].nonces), S(keys[n - 1].keyPackage), alpha))]));
  return s.aggregate(sp, S(shares), S(keys[0].publicKeyPackage), alpha);
}

const aegis = join(here, "..", "..", "tools", "bin", "aegis.exe");
for (const pair of [[1, 2], [2, 3], [1, 3]]) {
  const sig = sign(pair);
  if (!s.verify(S(keys[0].publicKeyPackage), alpha, msg, sig)) throw new Error(`wasm verify failed for ${pair}`);
  const out = execFileSync(aegis, ["verify-sig", "--ak", group, "--alpha", alpha, "--message", msg, "--signature", sig]).toString();
  if (!out.includes('"valid": true')) throw new Error(`consensus check failed for ${pair}`);
  console.log(`signers ${pair.join("+")}: valid under Orchard/Ironwood spend authorization`);
}
let refused = false;
try { s.signingPackage(S({ 1: J(s.signCommit(S(keys[0].keyPackage))).commitments }), msg); } catch { refused = true; }
if (!refused) throw new Error("a single signer was accepted");
console.log("single signer: refused");
console.log("group key:", group);
