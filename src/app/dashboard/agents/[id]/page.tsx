import { redirect } from "next/navigation";
import AgentWorkspace from "@/components/AgentWorkspace";
import Nav from "@/components/Nav";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) redirect("/login");
  const { id } = await params;
  return (
    <>
      <Nav email={user.email} />
      <AgentWorkspace id={id} />
    </>
  );
}
