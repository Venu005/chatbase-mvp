import { notFound, redirect } from "next/navigation";
import Admin from "@/components/Admin";
import Nav from "@/components/Nav";
import { getUser, isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Platform admin (ADMIN_EMAILS). Everyone else gets a plain 404, so the page isn't advertised.
export default async function AdminPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  if (!isAdmin(user)) notFound();
  return (
    <>
      <Nav email={user.email} admin />
      <Admin />
    </>
  );
}
