import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUserId } from "@/lib/session";

export async function GET() {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await prisma.reconciliationRun.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { discrepancies: { orderBy: { amountAtRisk: "desc" } } },
  });

  if (!run) {
    return NextResponse.json(null);
  }

  return NextResponse.json(run);
}
