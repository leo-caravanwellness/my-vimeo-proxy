import { NextResponse } from "next/server";
import { resolveShowcase } from "../../../lib/showcaseTokens";
import { logAccess } from "../../../lib/logAccess";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN!;
const USER_ID = process.env.VIMEO_USER_ID;        // for Project/Folder
const PROJECT_ID = process.env.VIMEO_PROJECT_ID;  // for Project/Folder

function clientIp(req: Request): string | undefined {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
}

// Return all fields from Vimeo API

function vimeoUrl(searchParams: URLSearchParams, albumId?: string) {
  const page = searchParams.get("page") ?? "1";
  const perPage = searchParams.get("per_page") ?? "20";
  const query = searchParams.get("query") ?? "";

  const base = albumId
    ? `https://api.vimeo.com/albums/${albumId}/videos`
    : `https://api.vimeo.com/users/${USER_ID}/projects/${PROJECT_ID}/videos`;

  const url = new URL(base);
  url.searchParams.set("page", page);
  url.searchParams.set("per_page", perPage);
  if (query) url.searchParams.set("query", query);
  return url.toString();
}

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const ip = clientIp(req);

  try {
    // Check API secret token or showcase token
    const authHeader = req.headers.get('authorization');
    const providedSecret = authHeader?.replace('Bearer ', '');

    const showcase = await resolveShowcase(providedSecret);
    if (!showcase) {
      logAccess({
        identifier: "UNAUTHORIZED",
        endpoint: "/api/vimeo/videos",
        method: "GET",
        status: 401,
        query: Object.fromEntries(searchParams),
        ip,
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!VIMEO_TOKEN) {
      return NextResponse.json({ error: "Missing VIMEO_TOKEN" }, { status: 500 });
    }

    const albumIdForToken = showcase.albumId;

    if (!albumIdForToken && !(USER_ID && PROJECT_ID)) {
      return NextResponse.json(
        { error: "No album configured for this token and no fallback project configured" },
        { status: 500 }
      );
    }

    const upstream = vimeoUrl(searchParams, albumIdForToken);
    const r = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${VIMEO_TOKEN}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
      cache: "no-store",
    });

    if (!r.ok) {
      const text = await r.text();
      logAccess({
        identifier: showcase.identifier,
        endpoint: "/api/vimeo/videos",
        method: "GET",
        status: r.status,
        albumId: albumIdForToken,
        query: Object.fromEntries(searchParams),
        ip,
      });
      return NextResponse.json({ error: "Vimeo error", detail: text }, { status: r.status });
    }

    const data = await r.json();

    logAccess({
      identifier: showcase.identifier,
      endpoint: "/api/vimeo/videos",
      method: "GET",
      status: 200,
      albumId: albumIdForToken,
      query: Object.fromEntries(searchParams),
      ip,
    });

    const response = NextResponse.json({
      success: true,
      data: data
    });

    // Add CORS headers
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    return response;
  } catch (e: any) {
    const response = NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });

    // Add CORS headers to error response too
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    return response;
  }
}

export async function OPTIONS(req: Request) {
  const response = new NextResponse(null, { status: 200 });

  // Add CORS headers for OPTIONS request
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  return response;
}
