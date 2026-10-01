import Link from "next/link";

export default function NotFound() {
  return (
    <div className="doc">
      <article className="prose">
        <h1>Page not found</h1>
        <p>
          This page doesn&apos;t exist or has moved. Try the search box above, or start from the <Link href="/">documentation home</Link>.
        </p>
      </article>
    </div>
  );
}
