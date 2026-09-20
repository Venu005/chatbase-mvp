import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (await getUser()) redirect("/dashboard");
  return (
    <main className="hero">
      <h1>An AI support agent trained on your business</h1>
      <p>
        Add your website, PDFs and FAQs. Get a chat agent that answers customers in their own language, on your website
        today and on WhatsApp next.
      </p>
      <div className="row-form center">
        <Link className="btn" href="/signup">Get started free</Link>
        <Link className="btn ghost" href="/login">Log in</Link>
      </div>
    </main>
  );
}
