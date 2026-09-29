import { redirect } from "next/navigation";
import Admin from "@/components/Admin";
import Nav from "@/components/Nav";
import { getAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await getAdmin();
  if (!admin) redirect("/login");
  return (
    <>
      <Nav email={admin.email} />
      <Admin />
    </>
  );
}
