export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'OPENAI_API_KEY is not configured on the server.'
    });
  }

  const prompt = req.body?.prompt;
  const webSearch = req.body?.webSearch === true;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ ok: false, error: 'A prompt is required.' });
  }

  if (prompt.length > 60000) {
    return res.status(413).json({ ok: false, error: 'Prompt is too large.' });
  }

  try {
    const payload = {
      model: webSearch
        ? (process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5')
        : (process.env.OPENAI_MODEL || 'gpt-6-luna'),
      input: prompt,
      max_output_tokens: webSearch ? 7000 : 5000
    };

    if (webSearch) {
      payload.tools = [{
        type: 'web_search',
        search_context_size: 'high',
        external_web_access: true
      }];

      // This is critical: CareerMitra's button explicitly means
      // "research this career from the internet", so search must run.
      payload.tool_choice = 'required';

      // Return the complete list of URLs consulted by web search.
      payload.include = ['web_search_call.action.sources'];
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }

    let text = '';
    const sources = [];

    if (!response.ok) {
      console.warn('Responses API returned', response.status, '- trying Chat Completions fallback...');
      const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || (webSearch ? 'gpt-4o' : 'gpt-4o-mini');
      try {
        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: fallbackModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            response_format: { type: 'json_object' }
          })
        });
        const chatRaw = await chatRes.text();
        let chatData = null;
        try { chatData = JSON.parse(chatRaw); } catch { chatData = null; }
        if (chatRes.ok && chatData?.choices?.[0]?.message?.content) {
          text = chatData.choices[0].message.content.trim();
        } else {
          console.error('OpenAI API error:', response.status, data || raw, 'Chat fallback:', chatRes.status, chatData || chatRaw);
          return res.status(502).json({
            ok: false,
            error:
              chatData?.error?.message ||
              data?.error?.message ||
              data?.message ||
              `AI provider request failed (HTTP ${response.status}).`
          });
        }
      } catch (fbErr) {
        return res.status(502).json({
          ok: false,
          error: data?.error?.message || fbErr?.message || `AI provider request failed (HTTP ${response.status}).`
        });
      }
    }

    if (typeof data?.output_text === 'string') {
      text = data.output_text.trim();
    }

    for (const item of Array.isArray(data?.output) ? data.output : []) {
      // Web-search output can contain source metadata separately from the final message.
      const actionSources = item?.action?.sources;
      if (Array.isArray(actionSources)) {
        for (const src of actionSources) {
          const u = src?.url;
          if (u && !sources.some(x => x.url === u)) {
            sources.push({
              title: String(src?.title || u),
              url: String(u)
            });
          }
        }
      }

      if (!Array.isArray(item?.content)) continue;

      for (const content of item.content) {
        if (!text && content?.type === 'output_text' && typeof content?.text === 'string') {
          text += content.text;
        }

        const annotations = Array.isArray(content?.annotations)
          ? content.annotations
          : [];

        for (const ann of annotations) {
          if (ann?.type !== 'url_citation') continue;
          const u = ann?.url || ann?.url_citation?.url;
          const title = ann?.title || ann?.url_citation?.title || u;
          if (u && !sources.some(x => x.url === u)) {
            sources.push({ title: String(title), url: String(u) });
          }
        }
      }
    }

    if (!text && Array.isArray(data?.output)) {
      for (const item of data.output) {
        for (const content of Array.isArray(item?.content) ? item.content : []) {
          if (typeof content?.text === 'string') text += content.text;
        }
      }
      text = text.trim();
    }

    if (!text) {
      console.error('AI returned no usable text:', JSON.stringify(data).slice(0, 8000));
      return res.status(502).json({ ok: false, error: 'AI returned no text.' });
    }

    let cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed = null;

    try {
      parsed = JSON.parse(cleaned);
    } catch {}

    if (!parsed) {
      const start = cleaned.indexOf('{');
      if (start !== -1) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < cleaned.length; i++) {
          const ch = cleaned[i];

          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\' && inString) {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;

          if (ch === '{') depth++;
          if (ch === '}') {
            depth--;
            if (depth === 0) {
              try {
                parsed = JSON.parse(cleaned.slice(start, i + 1));
              } catch {}
              break;
            }
          }
        }
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Invalid AI JSON:', text.slice(0, 4000));
      return res.status(502).json({ ok: false, error: 'AI returned invalid JSON.' });
    }

    return res.status(200).json({
      ok: true,
      data: parsed,
      ...(webSearch ? { sources: sources.slice(0, 30) } : {})
    });
  } catch (err) {
    console.error('CareerMitra AI proxy error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'AI service error.'
    });
  }
}
