import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createAppServer } from "../server.mjs";
import { triage } from "../triage.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };
let server;
let baseUrl;

before(async () => {
  server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function post(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.match(response.headers.get("content-type"), /^application\/json/);
  return { status: response.status, body: await response.json() };
}

for (const [label, body] of [
  ["empty body", ""],
  ["broken JSON", '{"text":'],
  ["missing text", "{}"],
  ["null body", "null"],
  ["array body", "[]"],
  ["string body", '"hello"'],
  ["null text", '{"text":null}'],
  ["numeric text", '{"text":42}'],
  ["boolean text", '{"text":false}'],
  ["object text", '{"text":{}}'],
  ["array text", '{"text":[]}'],
  ["empty text", '{"text":""}'],
  ["whitespace text", JSON.stringify({ text: " \n\t " })],
]) {
  test(`HTTP 400 for ${label}`, async () => {
    assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } });
  });
}

for (const [text, topic] of [
  ["Когда доставят заказ?", "delivery"],
  ["Какая стоимость?", "pricing"],
  ["Здравствуйте", "other"],
]) {
  test(`HTTP 200 with a ready ${topic} draft`, async () => {
    assert.deepEqual(await post(JSON.stringify({ text })), {
      status: 200,
      body: { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." },
    });
  });
}

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`HTTP 200 with manual_review for ${marker}`, async () => {
    const start = performance.now();
    assert.deepEqual(await post(JSON.stringify({ text: `Заявка ${marker}` })), {
      status: 200,
      body: manualReview,
    });
    if (marker === "[timeout]") {
      // The unchanged mock takes 1,200 ms; allow scheduling overhead on CI.
      assert.ok(performance.now() - start < 1_000, "Should not wait for the mock's full delay");
    }
  });
}

for (const [label, raw] of [
  ["null", "null"],
  ["an array", "[]"],
  ["a missing topic", '{"draft":"Ответ"}'],
  ["a missing draft", '{"topic":"other"}'],
  ["a non-string draft", '{"topic":"other","draft":42}'],
  ["a whitespace draft", '{"topic":"other","draft":" \\n "}'],
  ["an unknown topic", '{"topic":"refund","draft":"Ответ"}'],
  ["a non-string provider response", { topic: "other", draft: "Ответ" }],
]) {
  test(`Reject model output containing ${label}`, async () => {
    assert.deepEqual(await triage("Заявка", async () => raw), manualReview);
  });
}

test("Allowlisted output fields cannot be overwritten by the model", async () => {
  const result = await triage("Заявка", async () => JSON.stringify({
    status: "invalid_input", topic: "other", draft: "  Ответ\n", extra: "ignored",
  }));
  assert.deepEqual(result, { status: "ready", topic: "other", draft: "Ответ" });
});

test("A synchronous provider error also falls back to manual review", async () => {
  assert.deepEqual(await triage("Заявка", () => { throw new Error("Provider failed"); }), manualReview);
});

test("The 300 ms deadline aborts even a provider that ignores cancellation", async () => {
  let providerSignal;
  const start = performance.now();
  const result = await triage("Заявка", (_text, { signal }) => {
    providerSignal = signal;
    return new Promise(() => {});
  });
  const elapsed = performance.now() - start;
  assert.deepEqual(result, manualReview);
  assert.equal(providerSignal.aborted, true);
  assert.ok(elapsed >= 250 && elapsed < 1_000, `Expected about 300 ms, got ${elapsed} ms`);
});

test("A failed request does not prevent a later successful request", async () => {
  assert.deepEqual((await post('{"text":"[error]"}')).body, manualReview);
  assert.equal((await post('{"text":"Здравствуйте"}')).body.status, "ready");
});

test("The page is served and unknown routes return JSON 404", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(await page.text(), /<html lang="ru">/);
  for (const [method, path] of [["GET", "/api/triage"], ["POST", "/unknown"]]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: "not_found" });
  }
});
