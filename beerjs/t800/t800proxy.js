/**
 * VERTEX AI PROXY — Windows compatible
 * Usa Service Account JSON key (sin gcloud CLI).
 *
 * Setup:
 *   1. En Google Cloud Console → IAM → Service Accounts
 *   2. Crear SA con rol "Vertex AI User"
 *   3. Crear key JSON → descargar → poner junto a este archivo como service-account.json
 *   4. npm install
 *   5. node vertex-proxy.js
 *
 * El dashboard llama a: POST http://localhost:8080/vertex
 */

import { createServer }   from 'http';
import { readFileSync }   from 'fs';
import { GoogleAuth }     from 'google-auth-library';

// ─── Config ────────────────────────────────────────────
const PORT        = 18080;
const PROJECT_ID  = 'zulipcomunicator';
const LOCATION    = 'global';
const MODEL_ID    = 'claude-sonnet-4-6';
const SA_KEY_FILE = './service-account.json';

const VERTEX_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/${MODEL_ID}:rawPredict`;

// ─── Auth ──────────────────────────────────────────────
const auth = new GoogleAuth({
  keyFile: SA_KEY_FILE,
  scopes:  ['https://www.googleapis.com/auth/cloud-platform'],
});
let cachedClient = null;
async function getBearerToken() {
  if(!cachedClient) cachedClient = await auth.getClient();
  const { token } = await cachedClient.getAccessToken();
  return token;
}

// ─── Log ───────────────────────────────────────────────
const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', cyan:'\x1b[36m', gray:'\x1b[90m', yellow:'\x1b[33m' };
const log = (color, msg) => console.log(`${color}[${new Date().toLocaleTimeString()}] ${msg}${C.reset}`);

// ─── Server ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if(req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok', model:MODEL_ID, project:PROJECT_ID}));
    return;
  }

  if(req.method !== 'POST' || req.url !== '/vertex') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  log(C.cyan, `→ Request (${body.length} bytes)`);

  let token;
  try {
    token = await getBearerToken();
    log(C.gray, 'Token OK ✓');
  } catch(e) {
    log(C.red, `Auth error: ${e.message}`);
    log(C.yellow, 'Verificá que service-account.json existe y tiene rol "Vertex AI User"');
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Auth failed', detail: e.message}));
    return;
  }

  try {
    const response = await fetch(VERTEX_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json; charset=utf-8',
      },
      body,
    });
    const text = await response.text();
    log(response.ok ? C.green : C.red, `← Vertex ${response.status} (${text.length} bytes)`);
    if(!response.ok) log(C.red, `   ${text.substring(0,200)}`);
    res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') || 'application/json'});
    res.end(text);
  } catch(err) {
    log(C.red, `Fetch error: ${err.message}`);
    res.writeHead(502, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Vertex request failed', detail: err.message}));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log(`${C.green}╔══════════════════════════════════════╗${C.reset}`);
  console.log(`${C.green}║   🛡️  VERTEX AI PROXY — ONLINE       ║${C.reset}`);
  console.log(`${C.green}╠══════════════════════════════════════╣${C.reset}`);
  console.log(`${C.green}║  Endpoint → http://localhost:${PORT}   ║${C.reset}`);
  console.log(`${C.green}║  Proyecto → ${PROJECT_ID.padEnd(23)}║${C.reset}`);
  console.log(`${C.green}║  Modelo   → ${MODEL_ID.padEnd(23)}║${C.reset}`);
  console.log(`${C.green}║  Auth     → Service Account JSON     ║${C.reset}`);
  console.log(`${C.green}╚══════════════════════════════════════╝${C.reset}`);
  console.log('');
  try {
    readFileSync(SA_KEY_FILE);
    log(C.green, 'service-account.json encontrado ✓');
  } catch(_) {
    log(C.red,    '⚠  NO SE ENCONTRÓ service-account.json');
    log(C.yellow, '   → Google Cloud Console → IAM → Service Accounts');
    log(C.yellow, '   → Keys → Add Key → JSON → guardar como service-account.json');
  }
  getBearerToken()
    .then(()  => log(C.green, 'Auth pre-warmed ✓'))
    .catch(e  => log(C.red,   `Auth error: ${e.message}`));
});