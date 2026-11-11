import { paymentAgent } from "./agent/payment-agent";

async function main(): Promise<void> {
  try {
    const result = await paymentAgent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Create a PayPal order for 50 USD for Premium News service.",
        },
      ],
    });

    const lastMessage = result.messages.at(-1);

    console.log("\nAgent response:\n");
    console.log(lastMessage?.content);

  } catch (error) {
    console.error("Agent execution failed:", error);
    process.exitCode = 1;
  }
}

main();