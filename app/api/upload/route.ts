import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUserId } from "@/lib/session";
import { parseCsv, parseOrderDate, parsePaymentDate, normId, num } from "@/lib/csv";

export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Expected multipart/form-data with 'orders' and 'payments' files" }, { status: 400 });
  }

  const ordersFile = formData.get("orders");
  const paymentsFile = formData.get("payments");

  if (!(ordersFile instanceof File) || !(paymentsFile instanceof File)) {
    return NextResponse.json({ error: "Both 'orders' and 'payments' CSV files are required" }, { status: 400 });
  }

  let ordersRows: Record<string, string>[];
  let paymentsRows: Record<string, string>[];
  try {
    ordersRows = parseCsv(await ordersFile.text());
    paymentsRows = parseCsv(await paymentsFile.text());
  } catch (err) {
    return NextResponse.json({ error: "Could not parse one of the CSV files. Check the format." }, { status: 400 });
  }

  const requiredOrderCols = ["order_id", "order_date", "customer_email", "currency", "gross_amount", "discount", "net_amount", "status"];
  const requiredPaymentCols = ["transaction_ref", "processed_at", "order_reference", "currency", "amount", "fee", "net_settled", "type", "status"];

  if (ordersRows.length === 0 || !requiredOrderCols.every((c) => c in ordersRows[0])) {
    return NextResponse.json({ error: `orders.csv is missing required columns: ${requiredOrderCols.join(", ")}` }, { status: 400 });
  }
  if (paymentsRows.length === 0 || !requiredPaymentCols.every((c) => c in paymentsRows[0])) {
    return NextResponse.json({ error: `payments.csv is missing required columns: ${requiredPaymentCols.join(", ")}` }, { status: 400 });
  }

  // Replace any previous upload for this user so re-uploading is idempotent
  await prisma.$transaction([
    prisma.discrepancy.deleteMany({ where: { userId } }),
    prisma.reconciliationRun.deleteMany({ where: { userId } }),
    prisma.order.deleteMany({ where: { userId } }),
    prisma.payment.deleteMany({ where: { userId } }),
  ]);

  await prisma.order.createMany({
    data: ordersRows.map((r) => ({
      userId,
      orderId: r.order_id,
      normalizedId: normId(r.order_id),
      orderDate: parseOrderDate(r.order_date),
      customerEmail: r.customer_email,
      currency: r.currency,
      grossAmount: num(r.gross_amount),
      discount: num(r.discount),
      netAmount: num(r.net_amount),
      status: r.status.trim().toLowerCase(),
    })),
  });

  await prisma.payment.createMany({
    data: paymentsRows.map((r) => ({
      userId,
      transactionRef: r.transaction_ref,
      processedAt: parsePaymentDate(r.processed_at),
      orderReference: r.order_reference,
      normalizedRef: normId(r.order_reference),
      currency: r.currency,
      amount: num(r.amount),
      fee: num(r.fee),
      netSettled: num(r.net_settled),
      type: r.type.trim().toLowerCase(),
      status: r.status.trim().toLowerCase(),
    })),
  });

  return NextResponse.json({ ordersLoaded: ordersRows.length, paymentsLoaded: paymentsRows.length });
}
