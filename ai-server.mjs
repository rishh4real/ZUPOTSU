import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
try {
  const env = await readFile(join(rootDir, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, '');
  }
} catch { /* .env is optional in production, where secrets are supplied by the host. */ }

const port = Number(process.env.PORT || 4175);
const publicDir = join(rootDir, 'dist');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const localCors = { 'Access-Control-Allow-Origin':'http://localhost:4174', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const send = (res, status, body, headers={}) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...localCors, ...headers }); res.end(JSON.stringify(body)); };
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
const fallbackPrompt = 'You are Zupotsu AI, a concise sports-marketing intelligence assistant. Web research is temporarily unavailable. Give a practical, recommendation-first response using only reliable existing knowledge. Clearly flag time-sensitive claims that need verification. Never invent sources, figures, partnerships, availability, or access to private Zupotsu data. End every answer with exactly three next questions tailored to the user\'s specific brief, in this format: <followups>\\n- Question one\\n- Question two\\n- Question three\\n</followups>.';
const cleanMessages = (messages) => (Array.isArray(messages) ? messages : []).filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string').slice(-8).map((message) => ({ role:message.role, content:message.content.trim().slice(0,12000) })).filter((message) => message.content);
const cleanAnswer = answer => String(answer || '').replace(/\s*[【〖]\s*\d+\s*†\s*L?\d+(?:\s*[–—-]\s*L?\d+)?\s*[】〗]?/gu, '').replace(/\n{3,}/g, '\n\n').trim();
const parseCompletion = content => { const cleaned=cleanAnswer(content),match=cleaned.match(/<followups>\s*([\s\S]*?)\s*<\/followups>/i),followUps=match?match[1].split(/\r?\n/).map(item=>item.replace(/^\s*[-•\d.)]+\s*/,'').trim()).filter(Boolean).slice(0,3):[];return { answer:cleanAnswer(cleaned.replace(/<followups>[\s\S]*?<\/followups>/i,'')),followUps }; };

createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url === '/api/chat') { res.writeHead(204, localCors); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', async () => {
      try {
        if (!process.env.GROQ_API_KEY) return send(res, 503, { error:'Zupotsu AI is not connected yet. Add GROQ_API_KEY to the server environment, then restart it.' });
        const { messages, options = {} } = JSON.parse(raw || '{}');
        const latest = cleanMessages(messages);
        if (!latest.length || latest.at(-1).role !== 'user') return send(res, 400, { error:'Please send a question.' });
        const request = { model:process.env.GROQ_MODEL || 'openai/gpt-oss-20b', messages:[{ role:'system', content:systemPrompt(options.web !== false) },...latest], reasoning_effort:options.research ? 'medium' : 'low', temperature:.2, max_completion_tokens:options.research ? 1200 : 700 };
        if (options.web !== false) { request.tools = [{ type:'browser_search' }]; request.tool_choice = 'auto'; }
        const complete = body => fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${process.env.GROQ_API_KEY}` }, body:JSON.stringify(body) });
        let api = await complete(request);
        let data = await api.json();
        if (api.status === 429) {
          const fallback = { ...request, model:process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b', tools:undefined, tool_choice:undefined, max_completion_tokens:700, messages:[{ role:'system', content:fallbackPrompt },...latest] };
          api = await complete(fallback);
          data = await api.json();
        }
        if (!api.ok) return send(res, api.status, { error:data.error?.message || 'The AI provider returned an error.' });
        const completion=parseCompletion(data.choices?.[0]?.message?.content);
        return send(res, 200, { answer:completion.answer || 'I could not produce an answer for that yet.', followUps:completion.followUps, sources:[] });
      } catch { return send(res, 500, { error:'Something went wrong while contacting Zupotsu AI.' }); }
    }); return;
  }
  try {
    const cleanPath = req.url === '/' ? '/ai.html' : decodeURIComponent(req.url.split('?')[0]);
    const filePath = normalize(join(publicDir, cleanPath));
    if (!filePath.startsWith(publicDir)) throw new Error('invalid path');
    const file = await readFile(filePath); res.writeHead(200, { 'Content-Type':mime[extname(filePath)] || 'application/octet-stream' }); res.end(file);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Zupotsu AI running at http://localhost:${port}`));
