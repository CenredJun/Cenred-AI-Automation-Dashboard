// ============================================================
// Workflow 1 — Lead Qualify proxy
// Forwards lead form submissions to the n8n webhook for the
// Lead Qualify workflow. The n8n URL is hidden server-side via
// the N8N_LEAD_URL env var.
// ============================================================

const FETCH_TIMEOUT_MS = 25_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  const webhookUrl = process.env.N8N_LEAD_URL;
  if (!webhookUrl) {
    return jsonError(500, 'Server misconfigured: N8N_LEAD_URL is not set.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonError(400, 'Invalid JSON in request body.');
  }

  const name = (payload.name || '').trim();
  const email = (payload.email || '').trim();
  const company = (payload.company || '').trim();
  const message = (payload.message || '').trim();

  if (!name) return jsonError(400, 'Missing required field: name.');
  if (!email) return jsonError(400, 'Missing required field: email.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(400, 'Invalid email address.');
  if (!message) return jsonError(400, 'Missing required field: message.');
  if (name.length > 120) return jsonError(400, 'Name must be 120 characters or fewer.');
  if (company.length > 120) return jsonError(400, 'Company must be 120 characters or fewer.');
  if (message.length > 2000) return jsonError(400, 'Message must be 2000 characters or fewer.');

  const forwardBody = {
    name,
    email,
    company,
    message,
    startTs: Number.isFinite(payload.startTs) ? payload.startTs : Date.now(),
  };

  return forwardToN8n(webhookUrl, forwardBody);
};

async function forwardToN8n(webhookUrl, forwardBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardBody),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (!res.ok) {
      const msg = parsed?.message || parsed?.error || text || `n8n returned ${res.status}`;
      return jsonError(502, `Workflow error: ${msg}`);
    }
    if (!parsed) return jsonError(502, 'n8n returned a non-JSON response.');
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(parsed) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return jsonError(504, `Workflow took longer than ${FETCH_TIMEOUT_MS / 1000}s and was aborted.`);
    }
    return jsonError(500, err.message || 'Unexpected server error.');
  } finally {
    clearTimeout(timer);
  }
}

function jsonError(statusCode, message) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ ok: false, error: message }) };
}
