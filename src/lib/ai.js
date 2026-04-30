const OpenAI = require('openai');

let kimi = null;

function getKimi() {
  if (!kimi) {
    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) return null;
    kimi = new OpenAI({
      apiKey,
      baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    });
  }
  return kimi;
}

const MODEL = process.env.KIMI_MODEL || 'moonshot-v1-8k';

async function callKimi(prompt, maxTokens = 1024) {
  const client = getKimi();
  if (!client) throw new Error('KIMI_API_KEY not configured');

  const completion = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.6,
    messages: [
      {
        role: 'system',
        content:
          'You are a precise assistant. When asked for JSON, reply with valid JSON only — no prose, no code fences.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const choice = completion.choices && completion.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('Empty response from Kimi');
  return String(content).trim();
}

module.exports = { callKimi, getKimi };
