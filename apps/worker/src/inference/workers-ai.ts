import type { Model } from "./classify";

/**
 * The model's answer, from whichever shape it arrived in: most Workers AI models return
 * { response }, while some return an OpenAI chat completion. Anything else is handed back
 * untouched, so the adapter rejects it and records exactly what the model sent.
 *
 * Depending on the model, JSON mode returns either a string or an already-parsed object;
 * both pass through, and the adapter handles each.
 */
export function responseTextOf(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;

  const { response, choices } = result as { response?: unknown; choices?: unknown };
  if (response !== undefined) return response;
  if (!Array.isArray(choices)) return result;

  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  return content ?? result;
}

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
      return responseTextOf(result);
    },
  };
}
