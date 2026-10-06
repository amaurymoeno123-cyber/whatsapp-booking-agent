import { assertEquals } from "@std/assert";
import { hmacSha256Hex, verifyMetaSignature } from "../src/signature.ts";

const body = '{"entry":[]}';
const secret = "app-secret";

Deno.test("accepts a correctly signed body", async () => {
  const header = `sha256=${await hmacSha256Hex(secret, body)}`;
  assertEquals(await verifyMetaSignature(body, header, secret), true);
});

Deno.test("rejects a tampered body", async () => {
  const header = `sha256=${await hmacSha256Hex(secret, body)}`;
  assertEquals(await verifyMetaSignature(body + " ", header, secret), false);
});

Deno.test("rejects a missing or malformed header", async () => {
  assertEquals(await verifyMetaSignature(body, null, secret), false);
  assertEquals(await verifyMetaSignature(body, "md5=abc", secret), false);
});

Deno.test("fails closed when no secret is configured", async () => {
  const header = `sha256=${await hmacSha256Hex("any-secret", body)}`;
  assertEquals(await verifyMetaSignature(body, header, ""), false);
});

Deno.test("matches the RFC 4231 HMAC-SHA256 test vector", async () => {
  // RFC 4231 test case 2.
  assertEquals(
    await hmacSha256Hex("Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});
