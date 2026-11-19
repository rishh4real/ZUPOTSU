const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
};

const systemPrompt = (web) => `
You are Zupotsu AI: a sharp, practical sports-marketing intelligence assistant for brands, sports properties, talent, and agencies.

Your strongest domains are sponsorship strategy, athlete and talent partnerships, sports properties, fan engagement, media and content, brand positioning, and the Indian sports ecosystem. You can cover global sport too; name the market when it matters.

How to answer:
- Lead with the direct answer or recommendation in 1–2 sentences. Do not start with filler such as “Certainly” or repeat the question.
- For strategy questions, give at most 3 clear options or actions, explain why each fits, then end with one practical next step.
- Separate verified facts from recommendations. Mark assumptions when information is missing.
- Ask one focused clarifying question only when the answer would materially change based on missing information. Otherwise, make sensible assumptions and state them briefly.
- Be specific, commercially useful, and concise. Prefer bullets over long paragraphs. Never use markdown tables.
- Do not pretend to have access to Zupotsu's private catalogue, pricing, availability, clients, contracts, or campaign data. Offer a useful framework instead.
- Never invent figures, partnerships, current rosters, availability, news, or sources.
- When web research is off, do not name sports properties, organisations, rights packages, budgets, audience figures, or partnership availability unless the user supplied them. Use clear categories and say what needs validation.
- End every answer with exactly three highly relevant next questions inside this hidden handoff format: <followups>\n- Question one\n- Question two\n- Question three\n</followups>. The questions must build on the visitor's specific question and answer; never use generic repeat questions. Put any Sources section before this handoff.
${web
  ? '- Web research is available. You must use it for current, numerical, time-sensitive, or claim-heavy questions. Cite only sources you actually used in a compact “Sources” list at the end.'
  : '- Web research is off. Say when a time-sensitive detail needs verification rather than guessing.'}
`.trim();

const fallbackPrompt = `
You are Zupotsu AI, a concise sports-marketing intelligence assistant. Web research is temporarily unavailable. Give a practical, recommendation-first response using only reliable existing knowledge. Clearly flag time-sensitive claims that need verification. Never invent sources, figures, partnerships, availability, or access to private Zupotsu data.
End every answer with exactly three next questions tailored to the user's specific brief, in this format: <followups>\n- Question one\n- Question two\n- Question three\n</followups>.
`.trim();

const cleanMessages = (messages) => (Array.isArray(messages) ? messages : [])
  .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
  .slice(-8)
  .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 12000) }))
  .filter((message) => message.content);

const cleanAnswer = (answer) => String(answer || '')
  .replace(/\s*[【〖]\s*\d+\s*†\s*L?\d+(?:\s*[–—-]\s*L?\d+)?\s*[】〗]?/gu, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const parseCompletion = (content) => {
  const cleaned = cleanAnswer(content);
  const match = cleaned.match(/<followups>\s*([\s\S]*?)\s*<\/followups>/i);
  const followUps = match ? match[1]
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*[-•\d.)]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3) : [];
  return { answer: cleanAnswer(cleaned.replace(/<followups>[\s\S]*?<\/followups>/i, '')), followUps };
};

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
    const latest = cleanMessages(messages);
    if (!latest.length || latest.at(-1).role !== 'user') return json(res, 400, { error: 'Please send a question.' });
    const request = {
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: systemPrompt(options.web !== false) }, ...latest],
      reasoning_effort: options.research ? 'medium' : 'low',
      temperature: 0.2,
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
        messages: [{ role: 'system', content: fallbackPrompt }, ...latest]
      };
      response = await complete(fallback);
      data = await response.json();
    }

    if (!response.ok) return json(res, response.status, { error: data.error?.message || 'The AI provider returned an error.' });
    const completion = parseCompletion(data.choices?.[0]?.message?.content);
    return json(res, 200, { answer: completion.answer || 'I could not produce an answer for that yet.', followUps: completion.followUps, sources: [] });
  } catch (error) {
    return json(res, 500, { error: 'Something went wrong while contacting Zupotsu AI.' });
  }
}
