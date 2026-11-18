const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
};

const systemPrompt = (web) => web
  ? 'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. Answer clearly and distinguish verified facts from recommendations. For current or fact-sensitive questions, use web search when available and cite sources in a compact, readable way. Never invent current facts.'
  : 'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. Answer the user directly and clearly using only the information already available to you. Distinguish facts from recommendations and never invent current facts.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  // The public page and its API must be served from the same deployment. This blocks browser calls
  // from another origin while still allowing Vercel preview and production URLs.
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Requests must come from the Zupotsu site.' });
    } catch { return json(res, 403, { error: 'Invalid request origin.' }); }
  }

  if (!process.env.GROQ_API_KEY) return json(res, 503, { error: 'Zupotsu AI is not connected yet. Add GROQ_API_KEY in the Vercel project settings, then redeploy.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { messages, options = {} } = body;
    const latest = Array.isArray(messages) ? messages.slice(-8) : [];
    if (!latest.length || latest.some(message => typeof message?.content !== 'string')) return json(res, 400, { error: 'Please send a question.' });

    const prompt = latest.map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n');
    const request = {
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: systemPrompt(options.web !== false) }, { role: 'user', content: prompt }],
      reasoning_effort: options.research ? 'medium' : 'low',
      temperature: 1,
      max_completion_tokens: options.research ? 1200 : 700
    };
    if (options.web !== false) {
      request.tools = [{ type: 'browser_search' }];
      request.tool_choice = 'auto';
    }

    const complete = (payload) => fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(payload)
    });
    let response = await complete(request);
    let data = await response.json();

    if (response.status === 429) {
      const fallback = {
        ...request,
        model: process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b',
        tools: undefined,
        tool_choice: undefined,
        max_completion_tokens: 700,
        messages: [{ role: 'system', content: 'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. Live web-search capacity is busy, so answer clearly using existing knowledge and say when a fact needs verification.' }, { role: 'user', content: prompt }]
      };
      response = await complete(fallback);
      data = await response.json();
    }

    if (!response.ok) return json(res, response.status, { error: data.error?.message || 'The AI provider returned an error.' });
    return json(res, 200, { answer: data.choices?.[0]?.message?.content || 'I could not produce an answer for that yet.', sources: [] });
  } catch (error) {
    return json(res, 500, { error: 'Something went wrong while contacting Zupotsu AI.' });
  }
}
