import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Bearer tokens issued by Content Studio are listed (as SHA-256 digests, never
// raw) in a private S3 object that Content Studio writes and we only read:
//
//   { "version": 1, "tokens": [ { "sha256", "albumId", "identifier", "revoked", ... } ] }
//
// This module is deliberately free of relative imports so it can be unit
// tested with `node --test` directly.

export type RegistryEntry = {
  albumId: string;
  // Used in logs/SNS in place of the raw token, e.g. "CS_SAVORHEALTH".
  identifier: string;
};

// Returns the registry JSON text, or null when the registry does not exist
// (yet) or we are not allowed to read it — both mean "no registry tokens".
// Throws on anything else (network, credentials, ...), in which case the
// last good copy keeps being served.
export type RegistryFetcher = () => Promise<string | null>;

export type TokenRegistry = {
  lookup(token: string): Promise<RegistryEntry | undefined>;
};

const DEFAULT_TTL_MS = 60_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Z0-9_]{1,64}$/;
// albumId is interpolated into the Vimeo API path, so only accept digits.
const ALBUM_ID = /^[0-9]{1,20}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Parses registry JSON into a digest -> entry map of active tokens.
// Throws on malformed JSON; an unsupported version or invalid entries are
// skipped (logged) rather than thrown.
export function parseRegistry(
  text: string,
  log: (msg: string) => void = console.warn
): Map<string, RegistryEntry> {
  const entries = new Map<string, RegistryEntry>();
  const doc = JSON.parse(text);

  if (doc?.version !== 1) {
    log(`tokenRegistry: unsupported registry version ${JSON.stringify(doc?.version)}, ignoring registry`);
    return entries;
  }
  if (!Array.isArray(doc.tokens)) {
    log("tokenRegistry: registry has no tokens array, ignoring registry");
    return entries;
  }

  let skipped = 0;
  for (const t of doc.tokens) {
    if (t?.revoked === true) continue;
    const albumId = typeof t?.albumId === "number" ? String(t.albumId) : t?.albumId;
    if (
      typeof t?.sha256 !== "string" || !SHA256_HEX.test(t.sha256) ||
      typeof albumId !== "string" || !ALBUM_ID.test(albumId) ||
      typeof t?.identifier !== "string" || !IDENTIFIER.test(t.identifier)
    ) {
      skipped++;
      continue;
    }
    entries.set(t.sha256, { albumId, identifier: t.identifier });
  }
  if (skipped) log(`tokenRegistry: skipped ${skipped} invalid registry entr${skipped === 1 ? "y" : "ies"}`);

  return entries;
}

export function createTokenRegistry(opts: {
  fetch: RegistryFetcher;
  ttlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): TokenRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console.warn;

  let entries = new Map<string, RegistryEntry>();
  let fetchedAt = -Infinity;
  let inFlight: Promise<void> | undefined;
  let lastStatus = "";

  // Only log when the registry state changes, not on every refresh.
  function status(s: string, msg: string) {
    if (s !== lastStatus) log(msg);
    lastStatus = s;
  }

  async function refresh() {
    try {
      const text = await opts.fetch();
      if (text === null) {
        entries = new Map();
        status("missing", "tokenRegistry: registry not found or not readable, treating as empty");
      } else {
        entries = parseRegistry(text, log);
        status("ok", `tokenRegistry: loaded ${entries.size} active registry token(s)`);
      }
    } catch (err: any) {
      // Keep serving the last good copy.
      status(`error:${err?.name}`, `tokenRegistry: failed to refresh registry, keeping last good copy (${err?.name}: ${err?.message})`);
    } finally {
      // Also applies on error, so a broken registry is retried once per TTL
      // rather than on every request.
      fetchedAt = now();
    }
  }

  return {
    async lookup(token) {
      if (!token) return undefined;
      if (now() - fetchedAt >= ttlMs) {
        inFlight ??= refresh().finally(() => { inFlight = undefined; });
        await inFlight;
      }
      return entries.get(sha256Hex(token));
    },
  };
}

// Error names S3 uses for a missing bucket/object or a missing grant.
const EMPTY_REGISTRY_ERRORS = new Set(["NoSuchBucket", "NoSuchKey", "AccessDenied", "NotFound", "Forbidden"]);

export function s3RegistryFetcher(opts: { bucket: string; key: string; region?: string }): RegistryFetcher {
  let client: S3Client | undefined;
  return async () => {
    if (!opts.bucket || !opts.key || !opts.region) return null;
    client ??= new S3Client({ region: opts.region, followRegionRedirects: true });
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: opts.key }));
      return (await res.Body?.transformToString("utf-8")) ?? null;
    } catch (err: any) {
      if (EMPTY_REGISTRY_ERRORS.has(err?.name)) return null;
      throw err;
    }
  };
}

// Env tokens (TOKEN_TO_SHOWCASE) take precedence; registry is the fallback.
export async function resolveToken<T extends { identifier: string; albumId?: string }>(
  token: string | undefined,
  envTokens: Record<string, T>,
  registry: TokenRegistry
): Promise<T | RegistryEntry | undefined> {
  if (!token) return undefined;
  if (Object.hasOwn(envTokens, token)) return envTokens[token];
  return registry.lookup(token);
}
