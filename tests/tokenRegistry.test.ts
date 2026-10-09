import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTokenRegistry, parseRegistry, resolveToken } from "../app/lib/tokenRegistry.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const VALID = "valid-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVOKED = "revoked-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const registryJson = (tokens: object[], version: unknown = 1) =>
  JSON.stringify({ version, updated: "2026-10-09T15:00:00Z", tokens });

const FAKE_REGISTRY = registryJson([
  { sha256: sha(VALID), albumId: "12345678", identifier: "CS_SAVORHEALTH", client: "savorhealth", created: "2026-10-09T15:00:00Z", revoked: false, extra: "ignored" },
  { sha256: sha(REVOKED), albumId: "87654321", identifier: "CS_REVOKED", revoked: true },
]);

const ENV_TOKENS = { "env-secret": { albumId: "111", identifier: "PRUDENTIAL" } };

const quiet = () => {};

function fakeRegistry(fetch: () => Promise<string | null>, clock = { t: 0 }) {
  let calls = 0;
  const registry = createTokenRegistry({
    fetch: () => { calls++; return fetch(); },
    now: () => clock.t,
    log: quiet,
  });
  return { registry, clock, calls: () => calls };
}

test("valid registry token resolves to its album + identifier", async () => {
  const { registry } = fakeRegistry(async () => FAKE_REGISTRY);
  assert.deepEqual(await registry.lookup(VALID), { albumId: "12345678", identifier: "CS_SAVORHEALTH" });
});

test("revoked token is rejected", async () => {
  const { registry } = fakeRegistry(async () => FAKE_REGISTRY);
  assert.equal(await registry.lookup(REVOKED), undefined);
});

test("unknown and empty tokens are rejected", async () => {
  const { registry } = fakeRegistry(async () => FAKE_REGISTRY);
  assert.equal(await registry.lookup("nope"), undefined);
  assert.equal(await registry.lookup(""), undefined);
  // The digest itself is not a valid token.
  assert.equal(await registry.lookup(sha(VALID)), undefined);
});

test("env token still works and takes precedence; registry not fetched", async () => {
  const { registry, calls } = fakeRegistry(async () => FAKE_REGISTRY);
  assert.deepEqual(await resolveToken("env-secret", ENV_TOKENS, registry), ENV_TOKENS["env-secret"]);
  assert.equal(calls(), 0);
  assert.deepEqual(await resolveToken(VALID, ENV_TOKENS, registry), { albumId: "12345678", identifier: "CS_SAVORHEALTH" });
  assert.equal(await resolveToken(undefined, ENV_TOKENS, registry), undefined);
  // Prototype keys are not tokens.
  assert.equal(await resolveToken("constructor", ENV_TOKENS, registry), undefined);
});

test("registry missing (null) is treated as empty; env tokens unaffected", async () => {
  const { registry } = fakeRegistry(async () => null);
  assert.equal(await resolveToken(VALID, ENV_TOKENS, registry), undefined);
  assert.deepEqual(await resolveToken("env-secret", ENV_TOKENS, registry), ENV_TOKENS["env-secret"]);
});

test("registry unreachable from the start: rejects registry tokens, env tokens work", async () => {
  const { registry } = fakeRegistry(async () => { throw Object.assign(new Error("ECONNRESET"), { name: "TimeoutError" }); });
  assert.equal(await resolveToken(VALID, ENV_TOKENS, registry), undefined);
  assert.deepEqual(await resolveToken("env-secret", ENV_TOKENS, registry), ENV_TOKENS["env-secret"]);
});

test("cache: refetches after 60s, keeps last good copy on error, revocation applies after TTL", async () => {
  let respond: () => Promise<string | null> = async () => FAKE_REGISTRY;
  const { registry, clock, calls } = fakeRegistry(() => respond());

  assert.ok(await registry.lookup(VALID));
  clock.t = 59_000;
  assert.ok(await registry.lookup(VALID));
  assert.equal(calls(), 1, "served from cache within TTL");

  // Fetch fails after TTL: last good copy keeps serving.
  respond = async () => { throw new Error("S3 down"); };
  clock.t = 60_000;
  assert.ok(await registry.lookup(VALID));
  assert.equal(calls(), 2);

  // Malformed JSON also keeps the last good copy.
  respond = async () => "{not json";
  clock.t = 120_000;
  assert.ok(await registry.lookup(VALID));
  assert.equal(calls(), 3);

  // Token gets revoked: takes effect on the next refresh.
  respond = async () => registryJson([{ sha256: sha(VALID), albumId: "12345678", identifier: "CS_SAVORHEALTH", revoked: true }]);
  clock.t = 179_999;
  assert.ok(await registry.lookup(VALID), "still cached just before TTL");
  clock.t = 180_000;
  assert.equal(await registry.lookup(VALID), undefined);
});

test("concurrent lookups share one fetch", async () => {
  const { registry, calls } = fakeRegistry(async () => FAKE_REGISTRY);
  await Promise.all([registry.lookup(VALID), registry.lookup(VALID), registry.lookup("x")]);
  assert.equal(calls(), 1);
});

test("parseRegistry: unsupported version is treated as empty", () => {
  assert.equal(parseRegistry(registryJson([{ sha256: sha(VALID), albumId: "1", identifier: "CS_X" }], 2), quiet).size, 0);
});

test("parseRegistry: invalid entries are skipped, valid ones kept", () => {
  const map = parseRegistry(registryJson([
    { sha256: sha(VALID).toUpperCase(), albumId: "1", identifier: "CS_UPPERHEX" },
    { sha256: sha("a"), albumId: "1/../../me", identifier: "CS_BADALBUM" },
    { sha256: sha("b"), albumId: "1", identifier: "cs-lower" },
    { sha256: sha("c"), identifier: "CS_NOALBUM" },
    { sha256: sha("d"), albumId: 42, identifier: "CS_NUMERIC_ALBUM" },
  ]), quiet);
  assert.deepEqual([...map.values()], [{ albumId: "42", identifier: "CS_NUMERIC_ALBUM" }]);
});
