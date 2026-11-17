import { extractionPrompt } from "./memory-quality.mjs";
import { stableKinds } from "./schema-migration.mjs";
const kinds = new Set([...stableKinds, "tool_result"]);
export const stablePrompt =
  extractionPrompt +
  "\n补充：优先抽取口味、作息、习惯、忌讳、在乎的人、长期项目和明确承诺；why 在 40 字以内。";
export const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "subject", "predicate", "value", "quote"],
        properties: {
          kind: { type: "string", enum: [...kinds] },
          subject: { type: "string", maxLength: 24 },
          predicate: { type: "string", maxLength: 24 },
          value: { type: "string", maxLength: 60 },
          quote: { type: "string", minLength: 2, maxLength: 80 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};
