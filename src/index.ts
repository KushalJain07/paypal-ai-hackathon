import { runPaymentAgent } from "./agent/payment-agent.ts";

async function main(): Promise<void> {
  const instruction = process.argv.slice(2).join(" ").trim();
  if (!instruction) {
    console.error('Provide a payment instruction as an argument, for example: node src/index.ts "Request 250 cents under mandate <id> for buyer@example.com, invoice inv-123".');
    process.exitCode = 2;
    return;
  }
  const result = await runPaymentAgent(instruction);
  console.log(result.message);
}

main().catch(() => {
  console.error("Agent execution failed. Check the API and OpenRouter configuration.");
  process.exitCode = 1;
});
