import { listPayments, schedulePayment } from "@/lib/payments";

export async function GET() {
  const ready = process.env.NODE_ENV !== "production"
    && process.env.PAYPAL_AUTOMATION_ENABLED === "true"
    && Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  return Response.json({ payments: listPayments(), ready }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const ready = process.env.NODE_ENV !== "production"
    && process.env.PAYPAL_AUTOMATION_ENABLED === "true"
    && Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  if (!ready) {
    return Response.json({ error: "Set up PayPal Sandbox credentials and enable Sandbox automation in .env.local first." }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a valid JSON payment request." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Send a valid payment request." }, { status: 400 });
  }

  const { recipient, amount, note, undoMinutes } = body as Record<string, unknown>;
  const email = typeof recipient === "string" ? recipient.trim() : "";
  const rawAmount = typeof amount === "string" || typeof amount === "number" ? String(amount).trim() : "";
  const numericAmount = Number(rawAmount);
  const paymentNote = typeof note === "string" ? note.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return Response.json({ error: "Enter a valid recipient email address." }, { status: 400 });
  }
  if (!/^\d+(\.\d{1,2})?$/.test(rawAmount) || !Number.isFinite(numericAmount) || numericAmount < 0.01 || numericAmount > 500) {
    return Response.json({ error: "Enter an amount from $0.01 to $500.00 USD." }, { status: 400 });
  }
  if (paymentNote.length > 120) {
    return Response.json({ error: "Payment notes must be 120 characters or fewer." }, { status: 400 });
  }
  const minutes = Number(undoMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    return Response.json({ error: "Choose an undo window from 1 to 60 whole minutes." }, { status: 400 });
  }

  const payment = schedulePayment({ recipient: email, amount: numericAmount.toFixed(2), note: paymentNote, undoMinutes: minutes });
  return Response.json({ payment }, { status: 201 });
}
