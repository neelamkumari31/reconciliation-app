// Deterministic reconciliation engine.
//
// Design principle: this file contains ZERO calls to any LLM or external
// service. Given the same orders + payments rows, it always produces the
// same discrepancies. The LLM (see lib/llm.ts) only explains results this
// file has already decided on — it never influences matching.

export type OrderRow = {
  orderId: string;
  normalizedId: string;
  orderDate: Date;
  customerEmail: string;
  currency: string;
  grossAmount: number;
  discount: number;
  netAmount: number;
  status: string;
};

export type PaymentRow = {
  transactionRef: string;
  orderReference: string;
  normalizedRef: string;
  processedAt: Date;
  currency: string;
  amount: number;
  fee: number;
  netSettled: number;
  type: "charge" | "refund" | string;
  status: string;
};

export type DiscrepancyType =
  | "DUPLICATE_ORDER"        // same order_id appears more than once in orders.csv
  | "DUPLICATE_CHARGE"       // more than one settled charge for the same order
  | "MISSING_PAYMENT"        // completed order, no payment row at all
  | "ORPHAN_PAYMENT"         // payment references an order_id that doesn't exist
  | "AMOUNT_MISMATCH"        // matched 1:1, but amounts differ beyond tolerance
  | "PARTIAL_REFUND"         // charge + refund(s), net > 0 but < charge
  | "FULL_REFUND"            // charge fully offset by refund(s)
  | "CURRENCY_MISMATCH"      // order and payment currency differ for the same pair
  | "UNSETTLED_PAYMENT"      // payment exists but is pending/failed, not settled
  | "STATUS_MISMATCH";       // e.g. order cancelled but a settled charge exists

export type Discrepancy = {
  type: DiscrepancyType;
  orderRef: string | null;
  paymentRef: string | null;
  amountExpected: number | null;
  amountActual: number | null;
  amountAtRisk: number;
  severity: "low" | "medium" | "high";
  detail: string;
};

// Tolerance for "amounts effectively equal" — covers float/rounding noise
// (e.g. $0.01-$0.02 differences seen in the sample data) without masking
// genuine mismatches. Anything within this band is NOT flagged.
const AMOUNT_TOLERANCE = 0.02;

function norm(s: string): string {
  return s.trim().toUpperCase();
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_TOLERANCE;
}

export function reconcile(orders: OrderRow[], payments: PaymentRow[]) {
  const discrepancies: Discrepancy[] = [];

  // --- 1. Duplicate order rows -------------------------------------------
  const orderGroups = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const key = o.normalizedId;
    if (!orderGroups.has(key)) orderGroups.set(key, []);
    orderGroups.get(key)!.push(o);
  }
  for (const [key, group] of orderGroups) {
    if (group.length > 1) {
      discrepancies.push({
        type: "DUPLICATE_ORDER",
        orderRef: group[0].orderId,
        paymentRef: null,
        amountExpected: group[0].netAmount,
        amountActual: null,
        amountAtRisk: group[0].netAmount * (group.length - 1),
        severity: "medium",
        detail: `Order ${group[0].orderId} appears ${group.length} times in the order export with identical data. Likely a duplicate export row, not two real orders.`,
      });
    }
  }

  // --- 2. Group payments by normalized order reference --------------------
  const paymentGroups = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    const key = p.normalizedRef;
    if (!paymentGroups.has(key)) paymentGroups.set(key, []);
    paymentGroups.get(key)!.push(p);
  }

  const orderIds = new Set(orderGroups.keys());
  const paymentRefs = new Set(paymentGroups.keys());

  // --- 3. Orphan payments: payment ref with no matching order -------------
  for (const [ref, group] of paymentGroups) {
    if (!orderIds.has(ref)) {
      const totalAtRisk = group.reduce((s, p) => s + (p.type === "refund" ? -p.amount : p.amount), 0);
      discrepancies.push({
        type: "ORPHAN_PAYMENT",
        orderRef: null,
        paymentRef: group.map((p) => p.transactionRef).join(", "),
        amountExpected: null,
        amountActual: totalAtRisk,
        amountAtRisk: Math.abs(totalAtRisk),
        severity: "high",
        detail: `Payment(s) ${group.map((p) => p.transactionRef).join(", ")} reference order "${ref}", which does not exist in the order export. Money moved with no corresponding order.`,
      });
    }
  }

  // --- 4. Walk every distinct order and evaluate its payment situation ----
  for (const [orderKey, orderRows] of orderGroups) {
    // Use the first row as canonical if there were duplicates (already flagged above)
    const order = orderRows[0];
    const matchedPayments = paymentGroups.get(orderKey) ?? [];

    if (order.status === "cancelled") {
      // Cancelled orders shouldn't have settled charges against them
      const settledCharges = matchedPayments.filter((p) => p.type === "charge" && p.status === "settled");
      if (settledCharges.length > 0) {
        const amt = settledCharges.reduce((s, p) => s + p.amount, 0);
        discrepancies.push({
          type: "STATUS_MISMATCH",
          orderRef: order.orderId,
          paymentRef: settledCharges.map((p) => p.transactionRef).join(", "),
          amountExpected: 0,
          amountActual: amt,
          amountAtRisk: amt,
          severity: "high",
          detail: `Order ${order.orderId} is marked "cancelled" but has a settled charge of ${amt}. It was charged despite being cancelled.`,
        });
      }
      continue;
    }

    if (matchedPayments.length === 0) {
      // No payment row at all for a completed/refunded order
      if (order.status === "completed") {
        discrepancies.push({
          type: "MISSING_PAYMENT",
          orderRef: order.orderId,
          paymentRef: null,
          amountExpected: order.netAmount,
          amountActual: 0,
          amountAtRisk: order.netAmount,
          severity: "high",
          detail: `Order ${order.orderId} is marked "completed" with an expected value of ${order.netAmount}, but no payment record exists for it at all.`,
        });
      }
      continue;
    }

    const charges = matchedPayments.filter((p) => p.type === "charge");
    const refunds = matchedPayments.filter((p) => p.type === "refund");
    const settledCharges = charges.filter((p) => p.status === "settled");
    const unsettled = matchedPayments.filter((p) => p.status !== "settled");

    // Unsettled (pending/failed) payments, flagged separately from amount logic
    for (const p of unsettled) {
      discrepancies.push({
        type: "UNSETTLED_PAYMENT",
        orderRef: order.orderId,
        paymentRef: p.transactionRef,
        amountExpected: order.netAmount,
        amountActual: p.amount,
        amountAtRisk: p.status === "failed" ? order.netAmount : 0,
        severity: p.status === "failed" ? "high" : "low",
        detail: `Payment ${p.transactionRef} for order ${order.orderId} is "${p.status}", not settled. ${p.status === "failed" ? "The order is booked as revenue but the charge never went through." : "Still in flight — revisit once it settles."}`,
      });
    }

    // Duplicate settled charges for the same order
    if (settledCharges.length > 1) {
      // Group by identical amount — same amount charged 2x = likely double charge.
      const byAmount = new Map<number, PaymentRow[]>();
      for (const c of settledCharges) {
        const key = Math.round(c.amount * 100);
        if (!byAmount.has(key)) byAmount.set(key, []);
        byAmount.get(key)!.push(c);
      }
      for (const [, group] of byAmount) {
        if (group.length > 1) {
          const extra = group.slice(1);
          const amt = extra.reduce((s, p) => s + p.amount, 0);
          discrepancies.push({
            type: "DUPLICATE_CHARGE",
            orderRef: order.orderId,
            paymentRef: group.map((p) => p.transactionRef).join(", "),
            amountExpected: order.netAmount,
            amountActual: group[0].amount * group.length,
            amountAtRisk: amt,
            severity: "high",
            detail: `Order ${order.orderId} was charged ${group[0].amount} a total of ${group.length} times (${group.map((p) => p.transactionRef).join(", ")}). Customer was likely double-charged and is owed a refund of ${amt}.`,
          });
        }
      }
    }

    // Net position: settled charges minus refunds
    const totalCharged = settledCharges.reduce((s, p) => s + p.amount, 0);
    const totalRefunded = refunds.reduce((s, p) => s + p.amount, 0);
    const netPosition = totalCharged - totalRefunded;

    if (refunds.length > 0) {
      if (Math.abs(netPosition) <= AMOUNT_TOLERANCE) {
        discrepancies.push({
          type: "FULL_REFUND",
          orderRef: order.orderId,
          paymentRef: refunds.map((p) => p.transactionRef).join(", "),
          amountExpected: order.netAmount,
          amountActual: 0,
          amountAtRisk: 0,
          severity: "low",
          detail: `Order ${order.orderId} was charged ${totalCharged} and fully refunded (${totalRefunded}). Net position is zero — informational, not a discrepancy requiring action.`,
        });
      } else if (netPosition < totalCharged) {
        discrepancies.push({
          type: "PARTIAL_REFUND",
          orderRef: order.orderId,
          paymentRef: refunds.map((p) => p.transactionRef).join(", "),
          amountExpected: order.netAmount,
          amountActual: netPosition,
          amountAtRisk: 0, // money already settled correctly between the two parties
          severity: "low",
          detail: `Order ${order.orderId} was charged ${totalCharged} and partially refunded ${totalRefunded}, leaving a net of ${netPosition}. Confirm this matches the intended partial-refund amount.`,
        });
      }
      continue; // refund path handled; skip plain amount-mismatch check below
    }

    // Currency mismatch (checked before amount, since a currency swap often
    // produces a coincidentally-matching numeric amount)
    const currencyMismatched = settledCharges.some((p) => p.currency !== order.currency);
    if (currencyMismatched && settledCharges.length >= 1) {
      const p = settledCharges[0];
      discrepancies.push({
        type: "CURRENCY_MISMATCH",
        orderRef: order.orderId,
        paymentRef: p.transactionRef,
        amountExpected: order.netAmount,
        amountActual: p.amount,
        amountAtRisk: 0, // flagged as a data-quality issue, not necessarily lost money
        severity: "medium",
        detail: `Order ${order.orderId} is recorded in ${order.currency} but its payment ${p.transactionRef} is recorded in ${p.currency}, for the same numeric amount (${order.netAmount} vs ${p.amount}). Likely a currency field data-entry error rather than a real FX transaction.`,
      });
      continue;
    }

    // Plain amount mismatch on a clean 1:1 settled charge
    if (settledCharges.length === 1) {
      const p = settledCharges[0];
      if (!closeEnough(order.netAmount, p.amount)) {
        discrepancies.push({
          type: "AMOUNT_MISMATCH",
          orderRef: order.orderId,
          paymentRef: p.transactionRef,
          amountExpected: order.netAmount,
          amountActual: p.amount,
          amountAtRisk: Math.abs(order.netAmount - p.amount),
          severity: Math.abs(order.netAmount - p.amount) > 20 ? "high" : "medium",
          detail: `Order ${order.orderId} expected ${order.netAmount} but payment ${p.transactionRef} settled for ${p.amount}, a difference of ${(p.amount - order.netAmount).toFixed(2)}.`,
        });
      }
    }
  }

  return discrepancies;
}

export function summarize(orders: OrderRow[], payments: PaymentRow[], discrepancies: Discrepancy[]) {
  const totalOrderValue = orders.reduce((s, o) => s + o.netAmount, 0);
  const valueAtRisk = discrepancies.reduce((s, d) => s + d.amountAtRisk, 0);
  const disputedRefs = new Set(discrepancies.filter((d) => d.amountAtRisk > 0).map((d) => d.orderRef).filter(Boolean));
  const valueDisputed = orders
    .filter((o) => disputedRefs.has(o.orderId))
    .reduce((s, o) => s + o.netAmount, 0);
  const valueReconciled = totalOrderValue - valueDisputed;

  return {
    totalOrders: orders.length,
    totalPayments: payments.length,
    valueReconciled: Math.round(valueReconciled * 100) / 100,
    valueDisputed: Math.round(valueDisputed * 100) / 100,
    valueAtRisk: Math.round(valueAtRisk * 100) / 100,
  };
}
