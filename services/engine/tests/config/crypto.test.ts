import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/config/crypto.js";

describe("config/crypto", () => {
  it("encrypts and decrypts a value (round-trip)", async () => {
    const plain = "sk-test-api-key-12345";
    const cipher = await encrypt(plain);
    expect(cipher).not.toBe(plain);
    const decrypted = await decrypt(cipher);
    expect(decrypted).toBe(plain);
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const plain = "same-plaintext";
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a).not.toBe(b);
  });
});
