import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from "../src/http/passwords.ts";

/**
 * Password hashing, exercised through its two public functions only.
 *
 * No database, no server, no clock: what is asserted here is the property the stored
 * value must have — it is not the password, it verifies the password it came from,
 * and it refuses everything else without throwing.
 */

/** `scrypt$1$<N>$<r>$<p>$<saltB64>$<hashB64>`, as documented in the module. */
const STORED_FORMAT = /^scrypt\$1\$\d+\$\d+\$\d+\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/;

test("the stored value is not the password and follows the documented format", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.notEqual(stored, "correct horse battery");
  assert.ok(!stored.includes("correct horse battery"));
  assert.match(stored, STORED_FORMAT);
  // 16 salt bytes and a 32-byte key, base64 each: the parameters travel with the hash.
  assert.ok(stored.startsWith("scrypt$1$16384$8$1$"));
});

test("verification accepts the password the hash came from", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", stored), true);
});

test("verification rejects the wrong password", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse batterY", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("two hashes of one password differ, because the salt is random, and both verify", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery", first), true);
  assert.equal(await verifyPassword("correct horse battery", second), true);
});

test("a non-ASCII password round-trips", async () => {
  const password = "contraseña-ñandú-🔐";
  const stored = await hashPassword(password);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword("contrasena-nandu", stored), false);
});

test("a malformed stored value is refused instead of throwing", async () => {
  for (const stored of ["", "not-a-hash", "scrypt$1$bad", "scrypt$2$16384$8$1$c2FsdA==$aGFzaA=="]) {
    assert.equal(await verifyPassword("correct horse battery", stored), false, stored);
  }
});

test("hashing enforces the length bounds with the documented message", async () => {
  const message = `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`;
  assert.equal(message, "Password must be between 8 and 200 characters");

  await assert.rejects(hashPassword("1234567"), { message }, "7 characters is below the minimum");
  await assert.rejects(
    hashPassword("1".repeat(MAX_PASSWORD_LENGTH + 1)),
    { message },
    "201 characters is above the maximum",
  );

  const stored = await hashPassword("1".repeat(MAX_PASSWORD_LENGTH));
  assert.equal(await verifyPassword("1".repeat(MAX_PASSWORD_LENGTH), stored), true);
});

test("verification refuses an out-of-bounds candidate without throwing", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("1234567", stored), false);
  assert.equal(await verifyPassword("1".repeat(MAX_PASSWORD_LENGTH + 1), stored), false);
});
