/* Web Crypto helpers: PIN -> PBKDF2 -> AES-GCM */
const CryptoVault = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ITERATIONS = 600000;
  const KEY_BITS = 256;

  function bytesToB64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function b64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(pin, salt) {
    const material = await crypto.subtle.importKey(
      "raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: KEY_BITS },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptObject(object, pin, existingSaltB64 = null) {
    const salt = existingSaltB64 ? b64ToBytes(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const plaintext = enc.encode(JSON.stringify(object));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      version: 1,
      iterations: ITERATIONS,
      salt: bytesToB64(salt),
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(new Uint8Array(ciphertext))
    };
  }

  async function decryptObject(blob, pin) {
    if (!blob?.salt || !blob?.iv || !blob?.ciphertext) throw new Error("暗号データが不正です。");
    const salt = b64ToBytes(blob.salt);
    const iv = b64ToBytes(blob.iv);
    const key = await deriveKey(pin, salt);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv }, key, b64ToBytes(blob.ciphertext)
      );
      return JSON.parse(dec.decode(plaintext));
    } catch {
      throw new Error("暗証コードが違うか、データが破損しています。");
    }
  }

  function randomVaultCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return bytesToB64(bytes).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
  }

  return { encryptObject, decryptObject, randomVaultCode };
})();
