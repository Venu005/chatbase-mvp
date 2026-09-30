import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@chatbase/core/http";
import { checkAlerts } from "@chatbase/core/ops-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Checks the alerts now (the customer app's servers also do this every few minutes) and e-mails new ones. */
export const POST = handle(async () => {
  await requireAdmin();
  return NextResponse.json(await checkAlerts());
});
