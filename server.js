// chat-api: puerta de entrada del chatbot de novatierra.co
// Recibe mensajes del widget, aplica controles y los reenvía a n8n por la red interna.
// Sin dependencias externas: solo módulos de Node.
import http from 'node:http';

// ---------- Configuración (variables de entorno) ----------
const PORT = Number(process.env.PORT || 3000);
const N8N_CHAT_URL = process.env.N8N_CHAT_URL;
const N8N_SECRET = process.env.N8N_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_BODY_BYTES = 4096;          // tamaño máximo del cuerpo de la petición
const MAX_MSG_CHARS = 500;            // largo máximo de un mensaje
const MAX_MSGS_PER_SESSION = 30;      // mensajes por conversación
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // una conversación "vive" 2 horas
const RATE_WINDOW_MS = 60 * 1000;     // ventana del límite por IP
const RATE_MAX = 10;                  // mensajes por IP por minuto
const N8N_TIMEOUT_MS = 30 * 1000;

const ACCIONES = new Set(['ninguna', 'pedir_datos', 'mostrar_agenda']);
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

const FALLBACK = {
  respuesta: 'Disculpe, tuve un problema para responder. Puede escribirnos desde el formulario de contacto.',
  accion: 'mostrar_agenda',
};
const LIMITE_SESION = {
  respuesta: 'Hemos llegado al límite de esta conversación. Para seguir, lo mejor es agendar una consultoría con nuestro equipo.',
  accion: 'mostrar_agenda',
  limite: true,
};

if (!N8N_CHAT_URL || !N8N_SECRET || N8N_SECRET.length < 32 || ALLOWED_ORIGINS.length === 0) {
  console.error('Configuración incompleta: revise N8N_CHAT_URL, N8N_SECRET (mín. 32 caracteres) y ALLOWED_ORIGINS.');
  process.exit(1);
}

// ---------- Estado en memoria ----------
const ipHits = new Map();   // ip -> [marcas de tiempo]
const sessions = new Map(); // sessionId -> { count, last }

function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > RATE_MAX;
}

// Limpieza periódica para que la memoria no crezca
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some((t) => now - t < RATE_WINDOW_MS)) ipHits.delete(ip);
  for (const [id, s] of sessions) if (now - s.last > SESSION_TTL_MS) sessions.delete(id);
}, 60 * 1000).unref();

// ---------- Utilidades ----------
function clientIp(req) {
  // Traefik reemplaza X-Real-Ip con la IP real del visitante
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'desconocida');
}

function baseHeaders(origin) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function send(res, status, body, origin) {
  res.writeHead(status, baseHeaders(origin));
  res.end(body === null ? undefined : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Dejar de acumular; el resto se descarta y la conexión se cierra al responder
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('demasiado grande'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Quita caracteres de control e invisibles usados para engañar filtros
function limpiar(texto) {
  return texto
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Interpreta el texto del agente: JSON puro, JSON dentro de ```json ... ```,
// JSON con texto alrededor, o texto plano sin JSON.
function interpretarTexto(texto) {
  const limpio = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(limpio); } catch { /* sigue */ }
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio !== -1 && fin > inicio) {
    try { return JSON.parse(limpio.slice(inicio, fin + 1)); } catch { /* sigue */ }
  }
  // Sin JSON válido: si parece una respuesta en prosa, se usa tal cual
  if (limpio && !limpio.includes('"respuesta"')) return { respuesta: limpio, accion: 'ninguna' };
  return null;
}

// Normaliza y valida lo que devuelve n8n antes de enviarlo al navegador
function normalizarRespuesta(data) {
  if (Array.isArray(data)) data = data[0];
  if (data && typeof data === 'object' && 'output' in data) data = data.output;
  if (typeof data === 'string') data = interpretarTexto(data);
  if (!data || typeof data.respuesta !== 'string' || !data.respuesta.trim()) return null;
  return {
    respuesta: data.respuesta.trim().slice(0, 2000),
    accion: ACCIONES.has(data.accion) ? data.accion : 'ninguna',
  };
}

async function preguntarN8n(sessionId, mensaje) {
  const r = await fetch(N8N_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Secret': N8N_SECRET },
    body: JSON.stringify({ sessionId, mensaje }),
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  const cuerpo = await r.text();
  if (!r.ok) throw new Error(`n8n respondió ${r.status}: ${cuerpo.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(cuerpo); } catch { data = cuerpo; }
  const res = normalizarRespuesta(data);
  if (!res) console.error('Formato no reconocido. n8n devolvió:', cuerpo.slice(0, 300) || '(vacío)');
  return res;
}

// ---------- Rutas ----------
async function manejarChat(req, res, origin, ip) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Tipo de contenido no permitido' }, origin);
  }
  if (rateLimited(ip)) {
    return send(res, 429, { error: 'Demasiados mensajes. Espere un momento.' }, origin);
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.status === 413) {
      res.setHeader('Connection', 'close');
      return send(res, 413, { error: 'Petición demasiado grande' }, origin);
    }
    return send(res, 400, { error: 'Petición inválida' }, origin);
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const mensaje = typeof body?.mensaje === 'string' ? limpiar(body.mensaje) : '';
  if (!SESSION_RE.test(sessionId)) return send(res, 400, { error: 'Sesión inválida' }, origin);
  if (!mensaje) return send(res, 400, { error: 'El mensaje está vacío' }, origin);
  if (mensaje.length > MAX_MSG_CHARS) {
    return send(res, 400, { error: `El mensaje supera ${MAX_MSG_CHARS} caracteres` }, origin);
  }

  const s = sessions.get(sessionId) || { count: 0, last: 0 };
  if (s.count >= MAX_MSGS_PER_SESSION) return send(res, 200, LIMITE_SESION, origin);
  s.count += 1;
  s.last = Date.now();
  sessions.set(sessionId, s);

  try {
    const respuesta = await preguntarN8n(sessionId, mensaje);
    if (!respuesta) {
      console.error('Respuesta de n8n con formato inválido');
      return send(res, 200, FALLBACK, origin);
    }
    return send(res, 200, respuesta, origin);
  } catch (e) {
    console.error('Error consultando n8n:', e.name === 'TimeoutError' ? 'tiempo de espera agotado' : e.message);
    return send(res, 200, FALLBACK, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const inicio = Date.now();
  const origin = req.headers.origin;
  const ip = clientIp(req);
  const url = new URL(req.url, 'http://localhost');

  res.on('finish', () => {
    if (url.pathname !== '/health') {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - inicio}ms`);
    }
  });

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/chat') {
      // Solo se aceptan peticiones desde el sitio web
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return send(res, 403, { error: 'Origen no permitido' });
      }
      if (req.method === 'OPTIONS') return send(res, 204, null, origin);
      if (req.method === 'POST') return await manejarChat(req, res, origin, ip);
      return send(res, 405, { error: 'Método no permitido' }, origin);
    }

    return send(res, 404, { error: 'No encontrado' }, origin);
  } catch (e) {
    console.error('Error inesperado:', e.message);
    if (!res.headersSent) send(res, 500, { error: 'Error interno' }, origin);
  }
});

server.requestTimeout = 40 * 1000;
server.headersTimeout = 10 * 1000;
server.listen(PORT, () => console.log(`chat-api escuchando en el puerto ${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}