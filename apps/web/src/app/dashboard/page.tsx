import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import Nav from "@/components/Nav";
import { getUser } from "@chatbase/core/auth";
import { docsUrl } from "@chatbase/core/env";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  return (
    <>
      <Nav email={user.email} docsUrl={docsUrl()} />
      <Dashboard />
    </>
  );
}
