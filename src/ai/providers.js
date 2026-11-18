// AI providers: Google Gemini (cloud) and local servers (Ollama, LM Studio, any
// OpenAI-compatible endpoint). Local servers are called directly from the browser.
import { callGemini, DEFAULT_MODEL } from './gemini.js';

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', local: false },
  ollama: { label: 'Ollama', local: true, defaultUrl: 'http://localhost:11434' },
  lmstudio: { label: 'LM Studio', local: true, defaultUrl: 'http://localhost:1234' },
  openai: { label: 'Server compatibile OpenAI', local: true, defaultUrl: 'http://localhost:8080' },
};

/** current provider configuration from the saved settings */
export function providerConfig(s) {
  const provider = PROVIDERS[s.provider] ? s.provider : 'gemini';
  if (provider === 'gemini') return { provider, key: s.key || '', model: s.model || DEFAULT_MODEL };
  return {
    provider,
    url: (s[`${provider}Url`] || PROVIDERS[provider].defaultUrl).trim().replace(/\/+$/, ''),
    model: (s[`${provider}Model`] || '').trim(),
    key: provider === 'openai' ? (s.openaiKey || '').trim() : '',
  };
}

export function isConfigured(cfg) {
  return cfg.provider === 'gemini' ? !!cfg.key : !!cfg.model && !!cfg.url;
}

export function describeProvider(cfg) {
  const p = PROVIDERS[cfg.provider];
  return cfg.model ? `${p.label} · ${cfg.model}` : p.label;
}

/** OpenAI-style base URL ending in /v1 */
function v1(url) {
  return /\/v1$/.test(url) ? url : `${url}/v1`;
}

async function fetchJSON(url, init, cfg) {
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw new Error(unreachableMessage(cfg));
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 200) || `HTTP ${resp.status}`;
    if (resp.status === 404 && cfg.provider === 'ollama' && /model/i.test(String(msg))) {
      throw new Error(`Ollama: modello «${cfg.model}» non trovato. Scaricalo con: ollama pull ${cfg.model}`);
    }
    throw new Error(`${PROVIDERS[cfg.provider].label}: ${msg}`);
  }
  return data;
}

export function unreachableMessage(cfg) {
  const origin = typeof location !== 'undefined' ? location.origin : 'questo sito';
  if (cfg.provider === 'ollama') {
    return `Non riesco a contattare Ollama su ${cfg.url}. Controlla che Ollama sia avviato e che accetti richieste da questo sito: imposta la variabile d'ambiente OLLAMA_ORIGINS=${origin} e riavvia Ollama. Se il browser chiede il permesso di accedere alla rete locale, consenti.`;
  }
  if (cfg.provider === 'lmstudio') {
    return `Non riesco a contattare LM Studio su ${cfg.url}. In LM Studio apri la scheda Developer, avvia il server e attiva «Enable CORS». Se il browser chiede il permesso di accedere alla rete locale, consenti.`;
  }
  return `Non riesco a contattare il server su ${cfg.url}: controlla che sia avviato e che consenta richieste CORS da ${origin}.`;
}

/** list the models available on a local server */
export async function listModels(cfg) {
  if (cfg.provider === 'gemini') return [];
  if (cfg.provider === 'ollama') {
    const data = await fetchJSON(`${cfg.url}/api/tags`, {}, cfg);
    return (data?.models || []).map((m) => m.name || m.model).filter(Boolean);
  }
  const headers = cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {};
  const data = await fetchJSON(`${v1(cfg.url)}/models`, { headers }, cfg);
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

/** models whose name suggests they can read images */
export function looksLikeVisionModel(name) {
  return /(vl|vision|llava|bakllava|gemma-?3|gemma3|minicpm-?v|moondream|pixtral|qwen2\.5-?vl|qwen3-?vl|internvl|molmo|smolvlm|granite.*vision|mistral-small-3|llama-?4)/i.test(name);
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Send a prompt with optional JPEG images (base64, no prefix) and return the text reply.
 */
export async function chat(cfg, { text, images = [], json = true, signal } = {}) {
  if (cfg.provider === 'gemini') {
    const parts = [{ text }, ...images.map((b) => ({ inline_data: { mime_type: 'image/jpeg', data: b } }))];
    return callGemini({ key: cfg.key, model: cfg.model, parts, json, signal });
  }
  if (cfg.provider === 'ollama') {
    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content: text, ...(images.length ? { images } : {}) }],
      stream: false,
      options: { temperature: 0.1 },
      keep_alive: '15m',
      ...(json ? { format: 'json' } : {}),
    };
    const data = await fetchJSON(`${cfg.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }, cfg);
    return stripThinking(data?.message?.content);
  }
  const content = [{ type: 'text', text }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } }))];
  const body = { model: cfg.model, messages: [{ role: 'user', content }], temperature: 0.1, stream: false };
  const headers = { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) };
  const data = await fetchJSON(`${v1(cfg.url)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }, cfg);
  return stripThinking(data?.choices?.[0]?.message?.content);
}

/** quick end-to-end check: server reachable, model present, model answers */
export async function testConnection(cfg) {
  if (cfg.provider !== 'gemini') {
    const models = await listModels(cfg);
    if (!cfg.model) return { ok: false, message: `Connesso (${models.length} modelli disponibili): scegli un modello.`, models };
    if (models.length && !models.includes(cfg.model)) {
      return { ok: false, message: `Connesso, ma il modello «${cfg.model}» non è tra quelli disponibili.`, models };
    }
    const reply = await chat(cfg, { text: 'Rispondi solo con la parola OK.', json: false });
    const warn = looksLikeVisionModel(cfg.model) ? '' : ' Attenzione: questo modello potrebbe non leggere le immagini; usa un modello con visione.';
    return { ok: true, message: `✓ ${PROVIDERS[cfg.provider].label} risponde (${reply.slice(0, 30)}).${warn}`, models };
  }
  const reply = await chat(cfg, { text: 'Rispondi solo con la parola OK.', json: false });
  return { ok: true, message: `✓ La chiave funziona (risposta: ${reply.slice(0, 30)})`, models: [] };
}
