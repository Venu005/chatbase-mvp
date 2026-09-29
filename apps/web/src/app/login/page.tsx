import { redirect } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { getUser } from "@chatbase/core/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getUser()) redirect("/dashboard");
  return <AuthForm mode="login" />;
}
