import { redirect } from "next/navigation";
import Billing from "@/components/Billing";
import Nav from "@/components/Nav";
import { getUser } from "@chatbase/core/auth";
import { docsUrl } from "@chatbase/core/env";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  return (
    <>
      <Nav email={user.email} docsUrl={docsUrl()} />
      <Billing />
    </>
  );
}
