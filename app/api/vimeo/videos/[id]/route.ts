import { NextResponse } from "next/server";
import { resolveShowcase } from "../../../../lib/showcaseTokens";
import { logAccess } from "../../../../lib/logAccess";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN!;

function clientIp(req: Request): string | undefined {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ip = clientIp(req);
  const videoId = params.id;

  try {
    const authHeader = req.headers.get("authorization");
    const providedSecret = authHeader?.replace("Bearer ", "");

    const showcase = await resolveShowcase(providedSecret);
    if (!showcase) {
      logAccess({
        identifier: "UNAUTHORIZED",
        endpoint: "/api/vimeo/videos/[id]",
        method: "GET",
        status: 401,
        videoId,
        ip,
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!VIMEO_TOKEN) {
      return NextResponse.json({ error: "Missing VIMEO_TOKEN" }, { status: 500 });
    }

    const albumId = showcase.albumId;
    if (!albumId) {
      return NextResponse.json(
        { error: "No showcase configured for this token" },
        { status: 500 }
      );
    }

    // This endpoint returns the video only if it belongs to the album,
    // otherwise Vimeo returns 404 — so membership check is built in.
    const r = await fetch(
      `https://api.vimeo.com/albums/${albumId}/videos/${videoId}`,
      {
        headers: {
          Authorization: `Bearer ${VIMEO_TOKEN}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
        cache: "no-store",
      }
    );

    if (r.status === 404) {
      logAccess({
        identifier: showcase.identifier,
        endpoint: "/api/vimeo/videos/[id]",
        method: "GET",
        status: 404,
        albumId,
        videoId,
        ip,
      });
      const response = NextResponse.json(
        { error: "Video not found in this showcase" },
        { status: 404 }
      );
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return response;
    }

    if (!r.ok) {
      const text = await r.text();
      logAccess({
        identifier: showcase.identifier,
        endpoint: "/api/vimeo/videos/[id]",
        method: "GET",
        status: r.status,
        albumId,
        videoId,
        ip,
      });
      const response = NextResponse.json({ error: "Vimeo error", detail: text }, { status: r.status });
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return response;
    }

    const data = await r.json();
    logAccess({
      identifier: showcase.identifier,
      endpoint: "/api/vimeo/videos/[id]",
      method: "GET",
      status: 200,
      albumId,
      videoId,
      ip,
    });
    const response = NextResponse.json({ success: true, data });
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return response;
  } catch (e: any) {
    const response = NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return response;
  }
}

export async function OPTIONS(req: Request) {
  const response = new NextResponse(null, { status: 200 });
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  return response;
}
