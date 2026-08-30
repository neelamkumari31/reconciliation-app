import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUserId } from "@/lib/session";
import { explainDiscrepancies, LlmFormatError, LlmConfigError } from "@/lib/llm";

// Body: { discrepancyIds: string[] }
// Explains one or more discrepancies belonging to the logged-in user.
// Never trusts client-supplied discrepancy content — always re-reads from DB,
// scoped to userId, so a user cannot get an explanation for someone else's data.
export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.discrepancyIds) ? body.discrepancyIds : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "discrepancyIds is required" }, { status: 400 });
  }

  const discrepancies = await prisma.discrepancy.findMany({
    where: { id: { in: ids }, userId },
  });

  if (discrepancies.length === 0) {
    return NextResponse.json({ error: "No matching discrepancies found" }, { status: 404 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "LLM is not configured on the server" }, { status: 503 });
  }

  try {
    const explanation = await explainDiscrepancies(
      discrepancies.map((d) => ({
        type: d.type,
        orderRef: d.orderRef,
        paymentRef: d.paymentRef,
        amountExpected: d.amountExpected,
        amountActual: d.amountActual,
        amountAtRisk: d.amountAtRisk,
        detail: d.detail,
      }))
    );

    // Cache the explanation on the first (or only) discrepancy so repeated
    // views don't re-call the LLM.
    if (discrepancies.length === 1) {
      await prisma.discrepancy.update({
        where: { id: discrepancies[0].id },
        data: { explanation: JSON.stringify(explanation) },
      });
    }

    return NextResponse.json(explanation);
  } catch (err) {
    if (err instanceof LlmFormatError || err instanceof LlmConfigError) {
      return NextResponse.json({ error: "The AI explanation service returned an unexpected response. Please try again." }, { status: 502 });
    }
    console.error("LLM explain error:", err);
    return NextResponse.json({ error: "The AI explanation service is temporarily unavailable." }, { status: 502 });
  }
}
