"use client";

import { useState } from "react";

export default function AgentPage() {
  const [mandateId, setMandateId] = useState("");
  const [message, setMessage] = useState("Request the payment under my mandate.");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    setLoading(true);
    setResponse("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateId, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Agent request failed.");
      setResponse(typeof data.response === "string" ? data.response : JSON.stringify(data.response, null, 2));
    } catch (error) {
      setResponse(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "#080d18", color: "#eef2ff", padding: 40, fontFamily: "Arial" }}>
      <section style={{ maxWidth: 680, margin: "auto" }}>
        <p style={{ color: "#55d6be" }}>REWIND / AI PAYMENT AGENT</p>
        <h1>Your payment assistant.</h1>
        <p style={{ color: "#9ba9c2" }}>AI requests payments. REWIND validates every mandate independently.</p>
        <label>Mandate ID</label>
        <input value={mandateId} onChange={e => setMandateId(e.target.value)} placeholder="Paste mandate ID" style={fieldStyle} />
        <label>Message</label>
        <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} style={fieldStyle} />
        <button onClick={sendMessage} disabled={loading || !mandateId.trim() || !message.trim()} style={{ padding: 14, background: "#55d6be", border: 0, borderRadius: 9, fontWeight: "bold" }}>
          {loading ? "Processing..." : "Send to AI agent"}
        </button>
        {response && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#111b2c", padding: 20, borderRadius: 12, marginTop: 24 }}>{response}</pre>}
        <p style={{ color: "#74839d", fontSize: 12 }}>AI cannot capture, void, or override a payment.</p>
        <a href="/rewind" style={{ color: "#55d6be" }}>← Back to REWIND Guardian</a>
      </section>
    </main>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  margin: "8px 0 22px",
  padding: 14,
  borderRadius: 9,
  border: "1px solid #34445e",
  background: "#111b2c",
  color: "#eef2ff",
  fontSize: 15,
};
