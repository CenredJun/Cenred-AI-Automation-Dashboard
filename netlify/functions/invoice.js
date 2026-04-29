// ============================================================
// Workflow 2 — Invoice Gen proxy
// Forwards invoice form submissions to the n8n webhook for the
// Invoice Gen workflow. The n8n URL is hidden server-side via
// the N8N_INVOICE_URL env var.
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

  const webhookUrl = process.env.N8N_INVOICE_URL;
  if (!webhookUrl) {
    return jsonError(500, 'Server misconfigured: N8N_INVOICE_URL is not set.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonError(400, 'Invalid JSON in request body.');
  }

  const client = (payload.client || '').trim();
  const clientEmail = (payload.clientEmail || '').trim();
  const services = Array.isArray(payload.services) ? payload.services : [];

  if (!client) return jsonError(400, 'Missing required field: client.');
  if (!clientEmail) return jsonError(400, 'Missing required field: clientEmail.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) return jsonError(400, 'Invalid client email address.');
  if (client.length > 120) return jsonError(400, 'Client name must be 120 characters or fewer.');

  const cleanedServices = services
    .map(s => ({
      description: typeof s?.description === 'string' ? s.description.trim().slice(0, 200) : '',
      amount: Number(s?.amount || 0),
    }))
    .filter(s => s.description && s.amount > 0 && s.amount < 1_000_000);

  if (cleanedServices.length === 0) {
    return jsonError(400, 'At least one valid service line item is required (description + positive amount).');
  }
  if (cleanedServices.length > 20) {
    return jsonError(400, 'No more than 20 line items per invoice.');
  }

  const forwardBody = {
    client,
    clientEmail,
    services: cleanedServices,
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
