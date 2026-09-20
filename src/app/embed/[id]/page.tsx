import { notFound } from "next/navigation";
import ChatBox from "@/components/ChatBox";
import { q1 } from "@/lib/db";

export const dynamic = "force-dynamic";

// The page shown inside the widget's iframe (also usable as a standalone chat link).
export default async function EmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const agent = await q1<{ name: string; welcome_message: string; brand_color: string; handoff_enabled: boolean }>(
    "SELECT name, welcome_message, brand_color, handoff_enabled FROM agents WHERE id = $1",
    [id]
  );
  if (!agent) notFound();
  return (
    <div className="embed">
      <header className="embed-head" style={{ background: agent.brand_color }}>{agent.name}</header>
      <ChatBox agentId={id} welcome={agent.welcome_message} color={agent.brand_color} channel="widget" handoffEnabled={agent.handoff_enabled} />
    </div>
  );
}
