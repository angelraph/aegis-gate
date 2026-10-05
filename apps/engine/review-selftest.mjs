// The browser's payout review, run on real PCZTs from payouts that were mined on testnet.
//   node apps/engine/review-selftest.mjs
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const s = createRequire(import.meta.url)("./signer/aegis_signer.js");
const SELLER = "utest10emcaclksqhdj35tvffg3z4l3rxljh027v9ky9z2r5jwuyne08kgr336sl9hq77wcjg2cm7jyhhpy3tcyrj2dvjldqdamw65er2hulk3frhw7q95p4e684sv7wahvg369me2v0l267658e92zh0g6cthxae3pjmz8c5mdm575xtk2w4p36a99pqhudqkunr5m8wv7ds2za69w2nevde";
const OTHER = "utest1wky9q3kwgn7mfh367k2vfhjyxswyxffc8c7nvsp0s4gt6f97qapavk9ytx5ms369fp8qwk7d2fcr8d28xfgynctden672lh9yusp7yra";
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };

const root = join(here, "..", "..", "poc", ".deals-test");
const cases = [["4be991f37c", "release", SELLER], ["98035d5858", "refund", SELLER]];
for (const [deal, action, payee] of cases) {
  const dir = join(root, deal);
  const pay = readdirSync(dir).filter((d) => d.startsWith("payout-")).map((d) => join(dir, d)).find((d) => existsSync(join(d, "signatures.json")));
  const pczt = readFileSync(join(pay, "proven.pczt")).toString("base64");
  const group = readFileSync(join(dir, "group.hex"), "utf8").trim();
  const signedSighash = JSON.parse(readFileSync(join(pay, "request.json"), "utf8")).sighash;

  const good = JSON.parse(s.reviewPayout(pczt, group, deal, "test", payee));
  check(`${deal} ${action}: honest payout passes`, good.ok, `pays ${good.payout} zats, fee ${good.review.fee}`);
  check(`${deal} ${action}: browser's own sighash = the one actually signed and mined`, good.review.sighash === signedSighash);

  const wrong = JSON.parse(s.reviewPayout(pczt, group, deal, "test", OTHER));
  check(`${deal} ${action}: refused when it pays someone other than the agreed address`, !wrong.ok, wrong.reasons[0] || "");

  let otherDeal = null; try { otherDeal = JSON.parse(s.reviewPayout(pczt, group, "some-other-deal", "test", payee)); } catch (e) { otherDeal = { ok: false, reasons: [String(e.message || e)] }; }
  check(`${deal} ${action}: refused when the escrow isn't this deal's`, !otherDeal.ok, (otherDeal.reasons[0] || "").slice(0, 80));

  // Flip one byte at a time across the whole PCZT. Whatever the browser accepts must show
  // the person exactly the same payout, fee and value-carrying outputs: nothing that can
  // move or strand value may differ from what they approve.
  const raw = readFileSync(join(pay, "proven.pczt"));
  const shown = (r) => JSON.stringify([r.payout, r.review.fee, r.review.spent, r.review.outputs.map((o) => [o.receiver, o.value, o.to_escrow])]);
  let accepted = 0, misleading = 0, tried = 0;
  for (let off = 0; off < raw.length; off += Math.max(1, Math.floor(raw.length / 300))) {
    const t = Buffer.from(raw); t[off] ^= 0x01; tried++;
    try { const r = JSON.parse(s.reviewPayout(t.toString("base64"), group, deal, "test", payee)); if (r.ok) { accepted++; if (shown(r) !== shown(good)) misleading++; } } catch { /* refused */ }
  }
  check(`${deal} ${action}: ${tried} single-byte tamperings, none accepted with a different payout, fee or output`, misleading === 0, `(${accepted} harmless variants accepted, e.g. zero-value padding outputs)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
