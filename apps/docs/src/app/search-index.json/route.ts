import { load } from "@/lib/content";

// Built once with the site: every heading of every page with the text under it, for the search box.
export const dynamic = "force-static";

export function GET() {
  return Response.json(load().search);
}
