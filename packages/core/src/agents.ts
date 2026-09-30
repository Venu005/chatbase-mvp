import { q, q1 } from "./db";
import { HttpError } from "./http";

export type Agent = {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  welcome_message: string;
  brand_color: string;
  handoff_enabled: boolean;
  handoff_message: string;
  notify_email: boolean;
  allowed_domains: string[];
  lead_mode: "off" | "after_first_answer" | "before_chat";
  lead_fields: ("name" | "email" | "phone")[];
  lead_message: string;
  voice_enabled: boolean;
  voice_language: string;
  voice_speaker: string;
  voice_greeting: string;
  voice_transfer_number: string | null;
  voice_token: string;
  created_at: string;
};

/** Loads an agent only if it belongs to the user (multi-tenant guard used by every dashboard route). */
export async function ownAgent(userId: string, agentId: string): Promise<Agent> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new HttpError(404, "Agent not found");
  const a = await q1<Agent>("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [agentId, userId]);
  if (!a) throw new HttpError(404, "Agent not found");
  return a;
}
