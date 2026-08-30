"use client";

import { useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type Discrepancy = {
  id: string;
  type: string;
  orderRef: string | null;
  paymentRef: string | null;
  amountExpected: number | null;
  amountActual: number | null;
  amountAtRisk: number;
  severity: "low" | "medium" | "high";
  detail: string;
  explanation: string | null;
};

type Run = {
  id: string;
  createdAt: string;
  totalOrders: number;
  totalPayments: number;
  valueReconciled: number;
  valueDisputed: number;
  valueAtRisk: number;
  discrepancies: Discrepancy[];
};

function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

const TYPE_LABELS: Record<string, string> = {
  DUPLICATE_ORDER: "Duplicate order",
  DUPLICATE_CHARGE: "Duplicate charge",
  MISSING_PAYMENT: "Missing payment",
  ORPHAN_PAYMENT: "Orphan payment",
  AMOUNT_MISMATCH: "Amount mismatch",
  PARTIAL_REFUND: "Partial refund",
  FULL_REFUND: "Full refund",
  CURRENCY_MISMATCH: "Currency mismatch",
  UNSETTLED_PAYMENT: "Unsettled payment",
  STATUS_MISMATCH: "Status mismatch",
};

export function DashboardClient({ run }: { run: Run }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [explaining, setExplaining] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<Record<string, string>>({});
  const [explanations, setExplanations] = useState<Record<string, any>>({});

  const chartData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of run.discrepancies) {
      counts[d.type] = (counts[d.type] ?? 0) + 1;
    }
    return Object.entries(counts).map(([type, count]) => ({
      type: TYPE_LABELS[type] ?? type,
      count,
    }));
  }, [run.discrepancies]);

  const filtered = useMemo(() => {
    return run.discrepancies.filter((d) => {
      if (typeFilter !== "ALL" && d.type !== typeFilter) return false;
      if (severityFilter !== "ALL" && d.severity !== severityFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const haystack = `${d.orderRef ?? ""} ${d.paymentRef ?? ""} ${d.detail}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [run.discrepancies, typeFilter, severityFilter, search]);

  async function explain(d: Discrepancy) {
    setExplaining(d.id);
    setExplainError((prev) => ({ ...prev, [d.id]: "" }));
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discrepancyIds: [d.id] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to get explanation");
      setExplanations((prev) => ({ ...prev, [d.id]: data }));
    } catch (err: any) {
      setExplainError((prev) => ({ ...prev, [d.id]: err.message ?? "Something went wrong" }));
    } finally {
      setExplaining(null);
    }
  }

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Reconciliation Dashboard</h2>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Link href="/upload">Re-upload data</Link>
          <button onClick={() => signOut({ callbackUrl: "/login" })}>Log out</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: "1.5rem" }}>
        <div className="card">
          <div className="stat-label">Total Orders</div>
          <div className="stat-value">{run.totalOrders}</div>
        </div>
        <div className="card">
          <div className="stat-label">Total Payments</div>
          <div className="stat-value">{run.totalPayments}</div>
        </div>
        <div className="card">
          <div className="stat-label">Value Reconciled</div>
          <div className="stat-value ok">${run.valueReconciled.toFixed(2)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Value at Risk</div>
          <div className="stat-value risk">${run.valueAtRisk.toFixed(2)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ marginTop: 0 }}>Discrepancies by type</h3>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="type" angle={-20} textAnchor="end" interval={0} height={80} fontSize={12} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" fill="#1a1a1a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Drill-down</h3>
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          <input
            placeholder="Search order/payment ref…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="ALL">All types</option>
            {Object.keys(TYPE_LABELS).map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
          <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
            <option value="ALL">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Order</th>
              <th>Payment</th>
              <th>At risk</th>
              <th>Severity</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id}>
                <td>{TYPE_LABELS[d.type] ?? d.type}</td>
                <td>{d.orderRef ?? "—"}</td>
                <td>{d.paymentRef ?? "—"}</td>
                <td>{d.amountAtRisk > 0 ? money(d.amountAtRisk) : "—"}</td>
                <td><span className={`badge badge-${d.severity}`}>{d.severity}</span></td>
                <td style={{ maxWidth: 320 }}>
                  {d.detail}
                  {explanations[d.id] && (
                    <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "#444", background: "#f7f7f8", padding: "0.5rem", borderRadius: 6 }}>
                      <strong>What likely happened:</strong> {explanations[d.id].likely_cause}
                      <br />
                      <strong>Recommended action:</strong> {explanations[d.id].recommended_action}
                    </div>
                  )}
                  {explainError[d.id] && <p className="error-box" style={{ marginTop: "0.5rem" }}>{explainError[d.id]}</p>}
                </td>
                <td>
                  {!explanations[d.id] && (
                    <button onClick={() => explain(d)} disabled={explaining === d.id}>
                      {explaining === d.id ? "Explaining…" : "Explain"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "#999", padding: "1.5rem" }}>No discrepancies match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
