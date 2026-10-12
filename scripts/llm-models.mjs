// Lists each provider's models from inside the agent pod and checks the configured names.
// Prints model ids and HTTP statuses only, never keys. Run:
//   kubectl -n platform exec -i deploy/agent -- node --input-type=module - < scripts/llm-models.mjs
const providers = [
  ['primary', process.env.LLM_BASE_URL, process.env.LLM_MODEL, process.env.LLM_API_KEY],
  [
    'fallback',
    process.env.LLM_FALLBACK_BASE_URL,
    process.env.LLM_FALLBACK_MODEL,
    process.env.LLM_FALLBACK_API_KEY,
  ],
];
let failed = false;
for (const [name, base, model, key] of providers) {
  if (!base || !model || !key) {
    console.log(`${name}: not configured`);
    failed = true;
    continue;
  }
  const res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.log(`${name}: GET /models answered ${res.status}`);
    failed = true;
    continue;
  }
  const body = await res.json();
  // Gemini lists ids as models/<name>; requests take the bare name.
  const ids = (body.data ?? []).map((m) => String(m.id).replace(/^models\//, ''));
  const found = ids.includes(model);
  console.log(`${name}: ${model} ${found ? 'found' : 'MISSING'} among ${ids.length} models`);
  if (!found) {
    const near = ids.filter((id) => /flash|gpt-oss|qwen|llama/i.test(id)).sort();
    console.log(`${name} candidates: ${near.join(' ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
