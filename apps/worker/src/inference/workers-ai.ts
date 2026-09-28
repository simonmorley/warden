import type { Model } from "./classify";

/**
 * The real classifier: a Workers AI model, called through AI Gateway when a gateway is set,
 * so every raw response is logged and rate-limited there too. Temperature 0 and JSON mode
 * make answers as stable and well-formed as the model allows; the adapter validates
 * everything anyway.
 */
export function workersAiModel(ai: Ai, modelId: string, gatewayId: string | null): Model {
  return {
    id: modelId,
    async complete(request) {
      const result = await ai.run(
        modelId,
        {
          messages: request.messages,
          response_format: { type: "json_schema", json_schema: request.schema },
          temperature: 0,
          max_tokens: 400,
        },
        gatewayId ? { gateway: { id: gatewayId, skipCache: true, collectLog: true } } : {},
      );
      // Depending on the model, JSON mode hands back either a string or a parsed object.
      return (result as { response?: unknown }).response ?? result;
    },
  };
}
