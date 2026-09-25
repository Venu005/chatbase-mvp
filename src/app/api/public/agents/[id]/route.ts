import { NextResponse } from "next/server";
import { q1 } from "@/lib/db";
import { handle } from "@/lib/http";
import { hostAllowed, hostOf } from "@/lib/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Public, non-sensitive widget config. CORS is open so widget.js can read it from any website.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", vary: "Origin" };

export const OPTIONS = async () => new Response(null, { status: 204, headers: CORS });

export const GET = handle<Ctx>(async (req, { params }) => {
  const id = (await params).id;
  const agent = /^[0-9a-f-]{36}$/i.test(id)
    ? await q1<{ name: string; welcome_message: string; brand_color: string; allowed_domains: string[] }>(
        "SELECT name, welcome_message, brand_color, allowed_domains FROM agents WHERE id = $1",
        [id]
      )
    : null;
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS });
  // Lets widget.js skip showing the bubble on a website the owner hasn't allowed (the embed page enforces it).
  const origin = hostOf(req.headers.get("origin"));
  const allowed = !origin || origin === req.nextUrl.hostname || hostAllowed(origin, agent.allowed_domains);
  return NextResponse.json(
    { name: agent.name, welcomeMessage: agent.welcome_message, brandColor: agent.brand_color, allowed },
    { headers: CORS }
  );
});
