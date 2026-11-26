// The Search Master: optional AI helper (smart follow-up questions + "Make my search better").
// Needs one Vercel environment variable: ANTHROPIC_API_KEY
// Optional: SM_MODEL (defaults to claude-haiku-5-5), SM_HOURLY_LIMIT (defaults to 30 calls per visitor per hour)

const hits = new Map(); // simple per-visitor limit (resets when the server restarts)

const RULES = {
  Google: 'Google: plain words, "quotes" for exact phrases, OR (capitals) inside (parentheses), -word to exclude, site:, intitle:, filetype:, after:YYYY-MM-DD.',
  YouTube: 'YouTube: plain words in title order (e.g. "how to ..." in front, "... explained" or "... review" after). Quotes OK. Minus is unreliable, avoid relying on it.',
  Reddit: 'Searched through Google: site:reddit.com or site:reddit.com/r/NAME, plain words, "quotes", OR in parentheses, -word, after:YYYY-MM-DD.',
  'A Website': 'Searched through Google: site:domain.com, plain words, "quotes", intitle:, filetype:pdf, -word.',
  Facebook: 'Searched through Google: site:facebook.com or site:facebook.com/groups, plain words, "quotes", -word. For Marketplace: plain specific words only, no symbols.',
  LinkedIn: 'LinkedIn: AND, OR, NOT in CAPITALS, "quotes" for titles, (parentheses) to group, e.g. ("VP Marketing" OR "Head of Marketing") AND (SaaS OR software) NOT (intern OR recruiter).',
  Amazon: 'Amazon: plain, specific product words only (type, size, material, key features). No quotes, minus signs or operators.',
  X: 'X: plain words, "quotes", -word, from:handle, min_faves:N, since:YYYY-MM-DD, filter:media, filter:links, filter:news.'
};

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

async function askClaude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.SM_MODEL || 'claude-haiku-5-5',
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('AI error ' + r.status);
  const d = await r.json();
  const text = (d.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON');
  return JSON.parse(m[0]);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not set up' });

  // per-visitor hourly limit
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const now = Date.now(), limit = parseInt(process.env.SM_HOURLY_LIMIT || '30', 10);
  const rec = (hits.get(ip) || []).filter(t => now - t < 3600000);
  if (rec.length >= limit) return res.status(429).json({ error: 'Limit reached. Try again later.' });
  rec.push(now); hits.set(ip, rec);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const platform = Object.keys(RULES).includes(body.platform) ? body.platform : 'Google';

  try {
    if (body.mode === 'followup') {
      const topic = clip(body.topic, 200);
      if (!topic) return res.json({ questions: [] });
      const out = await askClaude(
        'You help people build better searches. Reply with JSON only. Keep everything family-friendly and national (not tied to one city). Never recommend specific companies, brands or local businesses unless the user already named them.',
        `Platform: ${platform}\nWhat the user is searching for: "${topic}"\n\nWrite 1 or 2 short multiple-choice questions that would most narrow this search (for example, for "jeans": Fit; Fabric). Rules:\n- Each question under 6 words.\n- 4 or 6 options per question.\n- Each option 1 to 3 words that make sense added to the search as words (e.g. "slim fit", "stretch").\n- Lowercase unless a proper noun.\nReturn only: {"questions":[{"q":"...","options":["..."]}]}\nIf the topic is too vague, unsafe or already specific, return {"questions":[]}.`
      );
      return res.json({ questions: Array.isArray(out.questions) ? out.questions.slice(0, 2) : [] });
    }
    if (body.mode === 'improve') {
      const query = clip(body.query, 400);
      if (!query) return res.status(400).json({ error: 'No search' });
      const out = await askClaude(
        'You are Mr. Paul, a friendly teacher who helps people search smarter. Reply with JSON only. Never add specific company, brand or local business names the user did not use.',
        `Platform: ${platform}\nSyntax rules: ${RULES[platform]}\nThe user's search: ${query}\n\nSuggest 2 to 4 SEPARATE small improvements the user can pick one by one. Each must work on its own and follow the platform's syntax rules exactly. Types:\n- "add": text to put at the end (an extra word, an OR group in parentheses, or an exclusion like -jobs)\n- "prefix": text to put at the front (like best)\n- "replace": {"from": an EXACT piece of the user's search, "to": the improved piece} (for example wrapping a multi-word phrase in quotes, or grouping words with OR in parentheses)\nRules: do not quote the main topic just to make it exact unless the user needs exact wording; quotes are for names and phrases that lose meaning when split. Never use square brackets. Each change gets a short label (under 6 words) and a one-sentence reason a beginner understands.\nReturn only: {"changes":[{"label":"...","add":"..."} or {"label":"...","prefix":"..."} or {"label":"...","replace":{"from":"...","to":"..."}}, each with "why":"..."]}\nIf the search is already strong, return {"changes":[],"note":"one short sentence why"}.`
      );
      const changes = (Array.isArray(out.changes) ? out.changes : []).slice(0, 4).map(c => {
        const o = { label: clip(c.label, 60), why: clip(c.why, 200) };
        if (c.replace && c.replace.from && c.replace.to) o.replace = { from: clip(c.replace.from, 200), to: clip(c.replace.to, 200) };
        else if (c.prefix) o.prefix = clip(c.prefix, 100);
        else if (c.add) o.add = clip(c.add, 150);
        return o;
      }).filter(c => c.label && (c.replace || c.prefix || c.add) && !/[\[\]]/.test(JSON.stringify(c.replace || c.prefix || c.add)));
      return res.json({ changes, note: clip(out.note, 200) });
    }
    return res.status(400).json({ error: 'Unknown mode' });
  } catch (e) {
    return res.status(502).json({ error: 'AI unavailable' });
  }
};
