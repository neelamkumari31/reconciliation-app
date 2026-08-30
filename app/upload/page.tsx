"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function UploadPage() {
  const router = useRouter();
  const [ordersFile, setOrdersFile] = useState<File | null>(null);
  const [paymentsFile, setPaymentsFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "reconciling" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ordersFile || !paymentsFile) {
      setError("Please select both files");
      return;
    }
    setError(null);
    setStatus("uploading");

    try {
      const formData = new FormData();
      formData.append("orders", ordersFile);
      formData.append("payments", paymentsFile);

      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const data = await uploadRes.json().catch(() => ({}));
        throw new Error(data.error ?? "Upload failed");
      }

      setStatus("reconciling");
      const reconcileRes = await fetch("/api/reconcile", { method: "POST" });
      if (!reconcileRes.ok) {
        const data = await reconcileRes.json().catch(() => ({}));
        throw new Error(data.error ?? "Reconciliation failed");
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setStatus("error");
    }
  }

  return (
    <div className="container">
      <h2>Load your data</h2>
      <p style={{ color: "#666" }}>Upload your orders and payments exports (CSV). Re-uploading replaces your previous data.</p>
      <div className="card" style={{ maxWidth: 480 }}>
        <form onSubmit={handleSubmit}>
          <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.9rem" }}>orders.csv</label>
          <input
            type="file"
            accept=".csv"
            onChange={(e) => setOrdersFile(e.target.files?.[0] ?? null)}
            style={{ marginBottom: "1rem", width: "100%" }}
          />
          <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.9rem" }}>payments.csv</label>
          <input
            type="file"
            accept=".csv"
            onChange={(e) => setPaymentsFile(e.target.files?.[0] ?? null)}
            style={{ marginBottom: "1rem", width: "100%" }}
          />
          {error && <p className="error-box">{error}</p>}
          <button type="submit" disabled={status === "uploading" || status === "reconciling"}>
            {status === "uploading" ? "Uploading…" : status === "reconciling" ? "Reconciling…" : "Upload & Reconcile"}
          </button>
        </form>
      </div>
    </div>
  );
}
