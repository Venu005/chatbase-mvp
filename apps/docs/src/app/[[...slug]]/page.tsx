import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { load, site } from "@/lib/content";
import Toc from "@/components/Toc";

type Props = { params: Promise<{ slug?: string[] }> };

// Every page is built ahead of time from docs/site.json; anything else is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return load().pages.map((p) => ({ slug: p.slug ? p.slug.split("/") : [] }));
}

const find = async (params: Props["params"]) => {
  const slug = ((await params).slug ?? []).join("/");
  const { pages } = load();
  const i = pages.findIndex((p) => p.slug === slug);
  return i < 0 ? null : { page: pages[i], prev: pages[i - 1], next: pages[i + 1] };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const f = await find(params);
  if (!f) return {};
  return { title: f.page.slug ? f.page.title : { absolute: "Chatbase India Docs" }, description: f.page.description || undefined };
}

export default async function DocPage({ params }: Props) {
  const f = await find(params);
  if (!f) notFound();
  const { page, prev, next } = f;
  return (
    <div className="doc">
      <article className="prose">
        <p className="crumb">{page.section}</p>
        <div dangerouslySetInnerHTML={{ __html: page.html }} />
        <footer className="doc-foot">
          <a href={`${site().repo}/edit/main/docs/${page.file}`} target="_blank" rel="noopener noreferrer">
            Edit this page on GitHub
          </a>
          <nav className="pager" aria-label="Previous and next page">
            {prev ? (
              <Link href={`/${prev.slug}`} className="prev">
                <span className="muted">Previous</span>
                {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/${next.slug}`} className="next">
                <span className="muted">Next</span>
                {next.title}
              </Link>
            )}
          </nav>
        </footer>
      </article>
      <Toc items={page.toc} />
    </div>
  );
}
