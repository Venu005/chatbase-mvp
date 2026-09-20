import { redirect } from "next/navigation";
import Billing from "@/components/Billing";
import Nav from "@/components/Nav";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  return (
    <>
      <Nav email={user.email} />
      <Billing />
    </>
  );
}
