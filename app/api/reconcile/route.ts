import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUserId } from "@/lib/session";
import { reconcile, summarize } from "@/lib/reconcile";

export async function POST() {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [orders, payments] = await Promise.all([
    prisma.order.findMany({ where: { userId } }),
    prisma.payment.findMany({ where: { userId } }),
  ]);

  if (orders.length === 0 || payments.length === 0) {
    return NextResponse.json({ error: "Upload orders and payments before reconciling" }, { status: 400 });
  }

  const orderRows = orders.map((o) => ({
    orderId: o.orderId,
    normalizedId: o.normalizedId,
    orderDate: o.orderDate,
    customerEmail: o.customerEmail,
    currency: o.currency,
    grossAmount: o.grossAmount,
    discount: o.discount,
    netAmount: o.netAmount,
    status: o.status,
  }));

  const paymentRows = payments.map((p) => ({
    transactionRef: p.transactionRef,
    orderReference: p.orderReference,
    normalizedRef: p.normalizedRef,
    processedAt: p.processedAt,
    currency: p.currency,
    amount: p.amount,
    fee: p.fee,
    netSettled: p.netSettled,
    type: p.type,
    status: p.status,
  }));

  const discrepancies = reconcile(orderRows, paymentRows);
  const summary = summarize(orderRows, paymentRows, discrepancies);

  const run = await prisma.reconciliationRun.create({
    data: {
      userId,
      totalOrders: summary.totalOrders,
      totalPayments: summary.totalPayments,
      valueReconciled: summary.valueReconciled,
      valueDisputed: summary.valueDisputed,
      valueAtRisk: summary.valueAtRisk,
      discrepancies: {
        create: discrepancies.map((d) => ({
          userId,
          type: d.type,
          orderRef: d.orderRef,
          paymentRef: d.paymentRef,
          amountExpected: d.amountExpected,
          amountActual: d.amountActual,
          amountAtRisk: d.amountAtRisk,
          severity: d.severity,
          detail: d.detail,
        })),
      },
    },
    include: { discrepancies: true },
  });

  return NextResponse.json(run);
}
