// Keywords Anthropic strict tool use rejects or cannot guarantee: string length
// bounds, maxItems, minItems above 1, and array-form `type` (use anyOf).
export function strictToolSchemaViolations(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => strictToolSchemaViolations(item, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const here = `${path}.${key}`;
    const own =
      key === "minLength" ||
      key === "maxLength" ||
      key === "maxItems" ||
      (key === "minItems" && typeof value === "number" && value > 1) ||
      (key === "type" && Array.isArray(value))
        ? [here]
        : [];
    return [...own, ...strictToolSchemaViolations(value, here)];
  });
}

export function withoutDescriptions(node: unknown): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value) => (key === "description" ? undefined : value)),
  );
}
