import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DashboardClient } from "./DashboardClient";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) redirect("/login");

  const run = await prisma.reconciliationRun.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { discrepancies: { orderBy: { amountAtRisk: "desc" } } },
  });

  if (!run) redirect("/upload");

  return <DashboardClient run={JSON.parse(JSON.stringify(run))} />;
}
