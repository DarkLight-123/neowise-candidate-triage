const topics = new Set(["delivery", "pricing", "other"]);
const modelTimeoutMs = 300;

function parseModelResult(raw) {
  if (typeof raw !== "string") throw new Error("Expected JSON text");
  const result = JSON.parse(raw);
  if (
    !result ||
    Array.isArray(result) ||
    !topics.has(result.topic) ||
    typeof result.draft !== "string" ||
    result.draft.trim() === ""
  ) {
    throw new Error("Invalid model result");
  }
  // Only these fields cross the model boundary; extra model fields are ignored.
  return { status: "ready", topic: result.topic, draft: result.draft.trim() };
}

export async function triage(text, classifyMessage) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timed out"));
        controller.abort();
      }, modelTimeoutMs);
    });
    // A race also bounds providers that ignore AbortSignal.
    const raw = await Promise.race([
      Promise.resolve().then(() => classifyMessage(text, { signal: controller.signal })),
      timeout,
    ]);
    return parseModelResult(raw);
  } catch {
    return { status: "manual_review", topic: null, draft: null };
  } finally {
    clearTimeout(timer);
  }
}
