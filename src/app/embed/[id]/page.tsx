import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ChatBox, { type LeadConfig } from "@/components/ChatBox";
import { q1 } from "@/lib/db";
import { embedAllowed } from "@/lib/domains";

export const dynamic = "force-dynamic";

// The page shown inside the widget's iframe (also usable as a standalone chat link).
export default async function EmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const agent = await q1<{
    name: string;
    welcome_message: string;
    brand_color: string;
    handoff_enabled: boolean;
    allowed_domains: string[];
    lead_mode: LeadConfig["mode"];
    lead_fields: LeadConfig["fields"];
    lead_message: string;
  }>(
    "SELECT name, welcome_message, brand_color, handoff_enabled, allowed_domains, lead_mode, lead_fields, lead_message FROM agents WHERE id = $1",
    [id]
  );
  if (!agent) notFound();
  const h = await headers();
  const allowed = embedAllowed({
    allowed: agent.allowed_domains,
    dest: h.get("sec-fetch-dest"),
    referer: h.get("referer"),
    selfHost: h.get("host")?.replace(/:\d+$/, "") ?? null,
  });
  if (!allowed) {
    return (
      <div className="embed">
        <p className="muted embed-blocked">This chat isn&apos;t enabled for this website.</p>
      </div>
    );
  }
  return (
    <div className="embed">
      <header className="embed-head" style={{ background: agent.brand_color }}>{agent.name}</header>
      <ChatBox agentId={id} welcome={agent.welcome_message} color={agent.brand_color} channel="widget" handoffEnabled={agent.handoff_enabled}
        lead={{ mode: agent.lead_mode, fields: agent.lead_fields, message: agent.lead_message }}
      />
    </div>
  );
}
