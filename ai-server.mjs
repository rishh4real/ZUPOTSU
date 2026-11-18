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

createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url === '/api/chat') { res.writeHead(204, localCors); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', async () => {
      try {
        if (!process.env.GROQ_API_KEY) return send(res, 503, { error:'Zupotsu AI is not connected yet. Add GROQ_API_KEY to the server environment, then restart it.' });
        const { messages, options = {} } = JSON.parse(raw || '{}');
        const latest = Array.isArray(messages) ? messages.slice(-8) : [];
        if (!latest.length || latest.some(message => typeof message.content !== 'string')) return send(res, 400, { error:'Please send a question.' });
        const prompt = latest.map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n');
        const request = { model:process.env.GROQ_MODEL || 'openai/gpt-oss-20b', messages:[{ role:'system', content:options.web === false ? 'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. Answer the user directly and clearly using only the information already available to you. Distinguish facts from recommendations and never invent current facts.' : 'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. Answer the user directly and clearly. Use browser search for current or fact-sensitive questions. Distinguish verified facts from recommendations and cite source markers in your response where relevant. Never invent current facts.' },{ role:'user', content:prompt }], reasoning_effort:options.research ? 'medium' : 'low', temperature:1, max_completion_tokens:options.research ? 1200 : 700 };
        if (options.web !== false) { request.tools = [{ type:'browser_search' }]; request.tool_choice = 'auto'; }
        const complete = body => fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${process.env.GROQ_API_KEY}` }, body:JSON.stringify(body) });
        let api = await complete(request);
        let data = await api.json();
        if (api.status === 429) {
          const fallback = { ...request, model:process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b', tools:undefined, tool_choice:undefined, max_completion_tokens:700, messages:[{ role:'system', content:'You are Zupotsu AI, a thoughtful sports marketing intelligence assistant. The live web-search capacity is temporarily busy, so answer clearly using your existing knowledge and say when a detail may need verification.' },{ role:'user', content:prompt }] };
          api = await complete(fallback);
          data = await api.json();
        }
        if (!api.ok) return send(res, api.status, { error:data.error?.message || 'The AI provider returned an error.' });
        return send(res, 200, { answer:data.choices?.[0]?.message?.content || 'I could not produce an answer for that yet.', sources:[] });
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
