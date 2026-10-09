import { createTokenRegistry, resolveToken, s3RegistryFetcher } from "./tokenRegistry";

const API_SECRET = process.env.API_SECRET;
const DEFAULT_ALBUM_ID = process.env.VIMEO_ALBUM_ID;

export type ShowcaseTokenInfo = {
  albumId?: string;
  // Human-readable name for this token, used in logging so raw secrets
  // never need to appear in logs.
  identifier: string;
};

// Dynamically load all showcase tokens from environment variables.
// Supports pattern: SHOWCASE_TOKEN_{IDENTIFIER} and SHOWCASE_ALBUM_ID_{IDENTIFIER}
// Example: SHOWCASE_TOKEN_PRUDENTIAL, SHOWCASE_ALBUM_ID_PRUDENTIAL
function loadShowcaseTokens(): Record<string, ShowcaseTokenInfo> {
  const tokenMap: Record<string, ShowcaseTokenInfo> = {};

  // Add the default API_SECRET mapping (backward compatibility)
  if (API_SECRET) {
    tokenMap[API_SECRET] = { albumId: DEFAULT_ALBUM_ID, identifier: "DEFAULT" };
  }

  // Scan environment variables for SHOWCASE_TOKEN_* pattern
  Object.keys(process.env).forEach((key) => {
    const match = key.match(/^SHOWCASE_TOKEN_([A-Z0-9_]+)$/);
    if (match) {
      const identifier = match[1];
      const token = process.env[key];
      const albumId = process.env[`SHOWCASE_ALBUM_ID_${identifier}`];

      if (token && albumId) {
        tokenMap[token] = { albumId, identifier };
      }
    }
  });

  return tokenMap;
}

// Map tokens to their respective album ID + identifier
export const TOKEN_TO_SHOWCASE = loadShowcaseTokens();

// Content Studio token registry (private S3 object, cached ~60s per instance).
const registry = createTokenRegistry({
  fetch: s3RegistryFetcher({
    bucket: process.env.CS_TOKEN_BUCKET ?? "caravan-content-studio-private",
    key: process.env.CS_TOKEN_KEY ?? "proxy-tokens.json",
    region: process.env.AWS_REGION,
  }),
});

// Resolve a bearer token to its showcase: env tokens first, then the
// Content Studio registry. Returns undefined if the token is not valid.
export function resolveShowcase(token: string | undefined): Promise<ShowcaseTokenInfo | undefined> {
  return resolveToken(token, TOKEN_TO_SHOWCASE, registry);
}
