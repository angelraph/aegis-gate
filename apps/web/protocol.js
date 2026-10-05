// Aegis Gate end-to-end encryption for key-ceremony messages.
//
// Round-2 FROST packages carry secret shares. If the relay could read them, the arbiter
// could reconstruct the whole 2-of-3 key, so each package is sealed to its recipient:
// ephemeral ECDH (P-256) + HKDF-SHA256 + AES-256-GCM, using WebCrypto. The same file runs
// in browsers and in the Node engine (globalThis.crypto).
//
// Integrity of the shares themselves is also checked by FROST: part 3 verifies every
// received share against the sender's public commitment, so a tampered package fails.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = enc.encode("aegis-gate/dkg-round2/v1");

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A fresh box key pair. Publish `publicKey`; keep `privateJwk` secret. */
export async function newBoxKey() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    publicKey: b64(await subtle.exportKey("raw", kp.publicKey)),
    privateJwk: await subtle.exportKey("jwk", kp.privateKey),
  };
}

async function aesKey(privateKey, publicKey, salt) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Seal a string to `recipientPublicKey` (base64 raw P-256). Returns a JSON-safe box. */
export async function seal(recipientPublicKey, plaintext) {
  const recipient = await subtle.importKey("raw", unb64(recipientPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const epk = await subtle.exportKey("raw", eph.publicKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(eph.privateKey, recipient, new Uint8Array(epk));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/** Open a box with our private JWK. Throws if it wasn't sealed to us or was altered. */
export async function open(privateJwk, box) {
  if (!box || box.v !== 1) throw new Error("Unknown sealed-box format.");
  const priv = await subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epkBytes = unb64(box.epk);
  const epk = await subtle.importKey("raw", epkBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await aesKey(priv, epk, epkBytes);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return dec.decode(pt);
}

/** Short, human-checkable fingerprint of a box public key (for out-of-band comparison). */
export async function fingerprint(publicKey) {
  const h = new Uint8Array(await subtle.digest("SHA-256", unb64(publicKey)));
  return Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("").match(/.{4}/g).join("-");
}

export const ROLE_ID = { buyer: 1, seller: 2, arbiter: 3 };
export const ID_ROLE = { 1: "buyer", 2: "seller", 3: "arbiter" };
