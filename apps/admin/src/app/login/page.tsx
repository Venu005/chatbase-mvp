import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { getAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getAdmin()) redirect("/");
  return <LoginForm />;
}
