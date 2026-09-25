import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ownAgent } from "@/lib/agents";
import { toCsv } from "@/lib/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type Lead = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  channel: string;
  source: string;
  created_at: string;
  conversation_id: string | null;
  first_message: string | null;
};

/** The agent's leads, newest first. `?format=csv` downloads all of them as a spreadsheet-friendly CSV. */
export const GET = handle<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const agent = await ownAgent(user.id, (await params).id);
  const csv = req.nextUrl.searchParams.get("format") === "csv";
  const leads = await q<Lead>(
    `SELECT l.id, l.name, l.email, l.phone, l.channel, l.source, l.created_at, c.id AS conversation_id,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message
       FROM leads l LEFT JOIN conversations c ON c.agent_id = l.agent_id AND c.session_id = l.session_id
      WHERE l.agent_id = $1 ORDER BY l.created_at DESC ${csv ? "" : "LIMIT 500"}`,
    [agent.id]
  );
  if (!csv) return NextResponse.json({ leads });

  const body = toCsv(
    ["Name", "E-mail", "Phone", "Channel", "Captured via", "Date", "First question"],
    leads.map((l) => [l.name, l.email, l.phone, l.channel, l.source, new Date(l.created_at).toISOString(), l.first_message])
  );
  const file = `leads-${agent.name.replace(/[^\w-]+/g, "-").slice(0, 40) || "agent"}-${new Date().toISOString().slice(0, 10)}.csv`;
  // BOM so Excel opens Hindi/Unicode names correctly.
  return new NextResponse("﻿" + body, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" },
  });
});
