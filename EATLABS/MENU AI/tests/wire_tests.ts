/**
 * Wire-format tests for the Qwen client.
 *
 * `run_tests.ts` mocks the `LlmClient` interface, which proves the pipeline but not
 * the HTTP. These tests stand up a local server that answers like vLLM's
 * OpenAI-compatible endpoint and drive the real client through it: request body,
 * headers, structured-output mode, parsing, retries and the downgrade path.
 *
 * No GPU and no model required.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createQwenClient, probeServer, DEFAULT_MODEL } from '../src/llm.ts';
import { createConcierge } from '../src/concierge.ts';
import { loadMenuFromFile } from '../src/menu_loader.ts';
import type { MenuItem } from '../src/types.ts';

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// A stand-in for vLLM
// ---------------------------------------------------------------------------

interface Recorded {
  path: string;
  authorization: string | undefined;
  body: Record<string, any>;
}

type Responder = (body: Record<string, any>, callIndex: number) =>
  | { status: number; json: unknown }
  | { status: number; text: string };

async function withServer(
  responder: Responder,
  run: (baseUrl: string, recorded: Recorded[]) => Promise<void>,
): Promise<void> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      recorded.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      const reply = responder(body, recorded.length - 1);
      res.statusCode = reply.status;
      if ('json' in reply) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply.json));
      } else {
        res.end(reply.text);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, recorded);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const completion = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const toolCompletion = (name: string, args: string) => ({
  choices: [
    {
      message: { role: 'assistant', content: null, tool_calls: [{ function: { name, arguments: args } }] },
      finish_reason: 'tool_calls',
    },
  ],
});

const FILTER_JSON = JSON.stringify({
  request_kind: 'MENU',
  dietary_include: ['vegan'],
  dietary_exclude: [],
  course: 'dessert',
  basic_tastes: [],
  flavor_notes: [],
  weight: null,
  party_size: null,
  sort_by: null,
  max_price_paise: null,
  unexpressed: [],
});

const SCHEMA = {
  name: 'emit_menu_filter',
  description: 'The structured menu filter.',
  schema: { type: 'object', properties: { sort_by: { type: ['string', 'null'] } }, additionalProperties: false },
};

const menuPath = fileURLToPath(new URL('../menu_database_200items.json', import.meta.url));
const MENU: MenuItem[] = (await loadMenuFromFile(menuPath)).menu;

// ---------------------------------------------------------------------------

test('a schema request goes out as OpenAI json_schema, with thinking off', async () => {
  await withServer(
    () => ({ status: 200, json: completion(FILTER_JSON) }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, temperature: 0, apiKey: 'none' });
      const text = await llm.complete({
        system: 'system prompt',
        user: 'guest text',
        maxTokens: 2000,
        responseSchema: SCHEMA,
      });

      assert.equal(text, FILTER_JSON);
      assert.equal(recorded.length, 1);
      const call = recorded[0];
      assert.ok(call);
      assert.equal(call.path, '/v1/chat/completions');
      assert.equal(call.authorization, 'Bearer none');
      assert.equal(call.body.model, DEFAULT_MODEL);
      assert.equal(call.body.temperature, 0);
      assert.equal(call.body.max_tokens, 2000);
      assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
      assert.deepEqual(call.body.messages, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'guest text' },
      ]);
      assert.equal(call.body.response_format.type, 'json_schema');
      assert.equal(call.body.response_format.json_schema.name, 'emit_menu_filter');
      assert.deepEqual(call.body.response_format.json_schema.schema, SCHEMA.schema);
      assert.equal(call.body.tools, undefined, 'json_schema mode must not also send tools');
    },
  );
});

test('a prose request carries no structured-output field', async () => {
  await withServer(
    () => ({ status: 200, json: completion('The Mango Sorbet is our vegan dessert.') }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, temperature: 0.3 });
      const text = await llm.complete({ system: 's', user: 'u', maxTokens: 700 });
      assert.equal(text, 'The Mango Sorbet is our vegan dessert.');
      assert.equal(recorded[0]?.body.response_format, undefined);
      assert.equal(recorded[0]?.body.temperature, 0.3);
    },
  );
});

test('tool mode sends OpenAI function calling and reads the arguments back', async () => {
  await withServer(
    () => ({ status: 200, json: toolCompletion('emit_menu_filter', FILTER_JSON) }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, structuredMode: 'tool' });
      const text = await llm.complete({ system: 's', user: 'u', maxTokens: 500, responseSchema: SCHEMA });
      assert.equal(text, FILTER_JSON);
      const body = recorded[0]?.body;
      assert.ok(body);
      assert.equal(body.tools[0].type, 'function');
      assert.equal(body.tools[0].function.name, 'emit_menu_filter');
      assert.deepEqual(body.tools[0].function.parameters, SCHEMA.schema);
      assert.equal(body.tool_choice.function.name, 'emit_menu_filter');
      assert.equal(body.response_format, undefined);
    },
  );
});

test('prompt mode puts the schema in the message and survives a code fence', async () => {
  await withServer(
    () => ({ status: 200, json: completion('```json\n' + FILTER_JSON + '\n```') }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, structuredMode: 'prompt' });
      const text = await llm.complete({ system: 's', user: 'u', maxTokens: 500, responseSchema: SCHEMA });
      assert.ok(text.includes('dietary_include'));
      const userMessage = recorded[0]?.body.messages[1].content;
      assert.ok(userMessage.includes('JSON only'), 'the schema instruction is in the prompt');
      assert.ok(userMessage.includes('additionalProperties'), 'the schema itself travels in the prompt');
      assert.equal(recorded[0]?.body.response_format, undefined);
    },
  );
});

test('a server without grammar support is downgraded once, not failed', async () => {
  await withServer(
    (body, index) => {
      if (index === 0 && body.response_format) {
        return { status: 400, text: '{"error":{"message":"response_format is not supported"}}' };
      }
      return { status: 200, json: completion(FILTER_JSON) };
    },
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl });
      const first = await llm.complete({ system: 's', user: 'u', maxTokens: 500, responseSchema: SCHEMA });
      assert.equal(first, FILTER_JSON);
      assert.equal(recorded.length, 2, 'rejected once, retried in prompt mode');
      assert.ok(recorded[1]?.body.response_format === undefined);

      // The downgrade sticks: the next call does not pay for the rejection again.
      await llm.complete({ system: 's', user: 'u', maxTokens: 500, responseSchema: SCHEMA });
      assert.equal(recorded.length, 3);
      assert.equal(recorded[2]?.body.response_format, undefined);
    },
  );
});

test('a 503 is retried and a 400 is not', async () => {
  await withServer(
    (_body, index) => (index === 0 ? { status: 503, text: 'server overloaded' } : { status: 200, json: completion('ok') }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, maxRetries: 2 });
      assert.equal(await llm.complete({ system: 's', user: 'u', maxTokens: 10 }), 'ok');
      assert.equal(recorded.length, 2);
    },
  );

  await withServer(
    () => ({ status: 400, text: 'bad request: max_tokens too large' }),
    async (baseUrl, recorded) => {
      const llm = createQwenClient({ baseUrl, maxRetries: 2 });
      await assert.rejects(
        () => llm.complete({ system: 's', user: 'u', maxTokens: 10 }),
        /returned 400/,
      );
      assert.equal(recorded.length, 1, 'a client error is not worth retrying');
    },
  );
});

test('a truncated answer is an error, not a half-parsed filter', async () => {
  await withServer(
    () => ({
      status: 200,
      json: { choices: [{ message: { content: '{"dietary_include": ["veg' }, finish_reason: 'length' }] },
    }),
    async (baseUrl) => {
      const llm = createQwenClient({ baseUrl, maxRetries: 0 });
      await assert.rejects(
        () => llm.complete({ system: 's', user: 'u', maxTokens: 10, responseSchema: SCHEMA }),
        /token limit/,
      );
    },
  );
});

test('an empty message is an error', async () => {
  await withServer(
    () => ({ status: 200, json: completion('   ') }),
    async (baseUrl) => {
      const llm = createQwenClient({ baseUrl, maxRetries: 0 });
      await assert.rejects(() => llm.complete({ system: 's', user: 'u', maxTokens: 10 }), /empty message/);
    },
  );
});

test('probeServer reports what the server is serving', async () => {
  await withServer(
    () => ({ status: 200, json: { data: [{ id: DEFAULT_MODEL }] } }),
    async (baseUrl) => {
      const probe = await probeServer({ baseUrl });
      assert.equal(probe.reachable, true);
      assert.deepEqual(probe.models, [DEFAULT_MODEL]);
    },
  );

  const unreachable = await probeServer({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1500 });
  assert.equal(unreachable.reachable, false);
});

test('the whole pipeline runs over real HTTP', async () => {
  await withServer(
    (body) => {
      // Stage 1 is the call carrying a schema; Stage 3 is the one that does not.
      if (body.response_format) return { status: 200, json: completion(FILTER_JSON) };
      const prompt = body.messages[1].content as string;
      assert.ok(prompt.includes('Mango Sorbet'), 'Stage 3 is handed the filtered item');
      assert.ok(prompt.includes('Desserts'), 'and the section it belongs to');
      assert.ok(!prompt.includes('Butter Chicken'), 'and nothing else from the menu');
      return { status: 200, json: completion('The Mango Sorbet is our one vegan dessert, at 120 rupees.') };
    },
    async (baseUrl, recorded) => {
      const concierge = createConcierge({
        intentLlm: createQwenClient({ baseUrl, temperature: 0 }),
        responseLlm: createQwenClient({ baseUrl, temperature: 0.3 }),
      });
      const result = await concierge('a vegan dessert please', MENU);

      assert.equal(result.matchType, 'exact');
      assert.deepEqual(result.items.map((i) => i.name), ['Mango Sorbet']);
      assert.equal(result.usedFallback, false);
      assert.match(result.message, /Mango Sorbet/);
      assert.equal(recorded.length, 2, 'exactly two model calls: one per stage');
      assert.equal(recorded[0]?.body.temperature, 0, 'Stage 1 parses deterministically');
      assert.equal(recorded[1]?.body.temperature, 0.3, 'Stage 3 is allowed some warmth');
    },
  );
});

test('a server outage still produces a true answer', async () => {
  await withServer(
    (body) => {
      if (body.response_format) return { status: 200, json: completion(FILTER_JSON) };
      return { status: 500, text: 'CUDA out of memory' };
    },
    async (baseUrl) => {
      const concierge = createConcierge({
        intentLlm: createQwenClient({ baseUrl, maxRetries: 0 }),
        responseLlm: createQwenClient({ baseUrl, maxRetries: 0 }),
      });
      const result = await concierge('a vegan dessert please', MENU);
      assert.equal(result.usedFallback, true, 'the deterministic sentence takes over');
      assert.match(result.message, /Mango Sorbet/);
      assert.ok(result.guardrailFailures[0]?.includes('generation failed'));
    },
  );
});

// ---------------------------------------------------------------------------

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
  }
}

console.log(`\n${passed}/${tests.length} passed`);
if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`\n--- ${name} ---\n${(error as Error).message}`);
  }
  process.exitCode = 1;
}
