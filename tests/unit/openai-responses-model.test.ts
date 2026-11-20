import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { OpenAIResponsesConfigSchema, OpenAIResponsesModel } from "../../src/llm/openai/openai-responses-model.ts";
import { ModelError } from "../../src/utils/errors.ts";

/** A local port that nothing listens on: bound once by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

describe("OpenAIResponsesModel", () => {
  it("reports why the API could not be reached, after retrying on a fresh connection pool", async () => {
    process.env.MCLAB_TEST_KEY = "sk-test";
    const model = new OpenAIResponsesModel(
      OpenAIResponsesConfigSchema.parse({
        id: "unreachable",
        provider: "openai",
        model: "gpt-6-luna",
        pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 },
        baseUrl: `http://127.0.0.1:${await closedPort()}/v1`,
        apiKeyEnv: "MCLAB_TEST_KEY",
        maxRetries: 0,
      }),
    );
    const call = model.generate({ instructions: "test", items: [{ kind: "user", text: "hi" }], tools: [] });
    await expect(call).rejects.toBeInstanceOf(ModelError);
    await expect(call).rejects.toThrow(
      /Could not reach the OpenAI API \(Connection error\. <- fetch failed <- .*ECONNREFUSED/,
    );
    await model.close();
  });
});
