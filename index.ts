import dotenv from "dotenv";
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

// Define interface for inference result
interface InferenceResult {
  choices?: Array<{
    message?: {
      content: string;
    };
  }>;
  error?: string;
}

/**
 * Makes an inference request to the specified endpoint
 * @param broker - The ZG Compute Broker instance
 * @param endpoint - API endpoint URL
 * @param headers - Request headers
 * @param content - Message content
 * @param model - AI model name
 * @returns The inference result
 */
async function makeInferenceRequest(
  broker: any,
  endpoint: string,
  headers: Record<string, string>,
  content: string,
  model: string,
): Promise<InferenceResult> {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "system", content }], model }),
  });
  return await response.json();
}

/**
 * Gets fresh request headers for each attempt
 * @param broker - The ZG Compute Broker instance
 * @param providerAddress - Address of the inference provider
 * @param content - Message content
 * @returns Request headers
 */
async function getNewHeaders(
  broker: any,
  providerAddress: string,
  content: string,
): Promise<Record<string, string>> {
  return await broker.inference.getRequestHeaders(providerAddress, content);
}

/**
 * Main function that runs the inference client
 */
export async function main(): Promise<void> {
  // Load environment variables
  dotenv.config();

  // Configuration
  const PRIVATE_KEY =
    process.env.PRIVATE_KEY ||
    "";
  const RPC_URL = process.env.RPC_URL || "https://evmrpc-testnet.0g.ai";
  const PROVIDER_ADDRESS =
    process.env.PROVIDER_ADDRESS ||
    "0x3feE5a4dd5FDb8a32dDA97Bed899830605dBD9D3";
  const INITIAL_BALANCE = process.env.INITIAL_BALANCE
    ? Number.parseFloat(process.env.INITIAL_BALANCE)
    : 0.05;
  const MAX_RETRIES = process.env.MAX_RETRIES
    ? Number.parseInt(process.env.MAX_RETRIES)
    : 5;
  const CONTENT = process.env.CONTENT || "Hello from 0g serving broker!";

  // Initialize provider and wallet
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Initialize broker
  const broker = await createZGComputeNetworkBroker(wallet);
  console.log("Inference Broker initialized");

  // Setup ledger
  try {
    const existingBalance = await broker.ledger.getLedger();
    console.log("Using existing ledger with balance:", existingBalance);
  } catch (error) {
    console.log("No existing ledger found. Creating new ledger...");
    await broker.ledger.addLedger(INITIAL_BALANCE);
    console.log(
      "New account created and funded with initial balance:",
      INITIAL_BALANCE,
    );
  }

  // List available services
  console.log("Listing services...");
  const services = await broker.inference.listService();
  console.log("Available inference providers:", services);

  // Get service metadata
  console.log("Getting service metadata...");
  const { endpoint, model } =
    await broker.inference.getServiceMetadata(PROVIDER_ADDRESS);
  console.log("Endpoint:", endpoint, "Model:", model);

  // Make inference requests with retry logic
  let retryCount = 0;
  let result: InferenceResult | undefined;

  while (retryCount < MAX_RETRIES) {
    try {
      // Get fresh headers for each attempt
      const currentHeaders = await getNewHeaders(
        broker,
        PROVIDER_ADDRESS,
        CONTENT,
      );
      console.log("Preparing to call makeInferenceRequest...");
      const startTimeMs = Date.now();
      const startDate = new Date(startTimeMs);
      console.log(`Request start time: ${startDate.toISOString()} (Timestamp: ${startTimeMs})`);
      result = await makeInferenceRequest(
        broker,
        endpoint,
        currentHeaders,
        CONTENT,
        model,
      );
      const endTimeMs = Date.now();
      const endDate = new Date(endTimeMs);
      const durationMs = endTimeMs - startTimeMs;
      console.log(`Request end time: ${endDate.toISOString()} (Timestamp: ${endTimeMs})`);
      console.log(`Request successful, duration: ${durationMs} ms`);
      console.log(`Attempt ${retryCount + 1} result:`, result);

      // If we have a valid response, break the loop
      if (result?.choices?.[0]?.message?.content) {
        console.log("Success! Message:", result.choices[0].message.content);
        break;
      }

      // Handle fee settlement error
      if (result.error?.includes("settleFee")) {
        const feeMatch = result.error.match(/expected ([\d.]+) A0GI/);
        if (feeMatch) {
          const expectedFee = Number(feeMatch[1]);
          console.log("Settling fee:", expectedFee);
          await broker.inference.settleFee(PROVIDER_ADDRESS, expectedFee);
          console.log("Fee settled successfully");
        }
      }

      // If we get here, either there was an error or no valid response
      console.log(`Attempt ${retryCount + 1} failed, retrying...`);
      retryCount++;

      // Add a small delay between retries
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Error on attempt ${retryCount + 1}:`, error);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!result?.choices?.[0]?.message?.content) {
    console.log(`Failed to get valid response after ${MAX_RETRIES} attempts`);
  }

  // Display remaining balance
  const remainingBalance = await broker.ledger.getLedger();
  console.log("Remaining balance in ledger:", remainingBalance.ledgerInfo);
}

// Execute main function if this file is run directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Error in main execution:", error);
      process.exit(1);
    });
}
