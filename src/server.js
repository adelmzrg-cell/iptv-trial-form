// Serveur "file d'attente" : recoit les demandes des clients (formulaire en ligne),
// les met en attente, et renvoie les accès une fois que le userscript (dans le Chrome
// d'Adel) a cree le compte. Ce serveur ne parle JAMAIS au panel -> aucun souci Cloudflare.
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.set('trust proxy', 1); // derriere le proxy Coolify (Traefik) -> vraie IP client
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const TOKEN = process.env.SCRIPT_TOKEN || '';
const PORT = process.env.PORT || 3000;

// Anti-abus
const REQUEST_COOLDOWN_MS = 30 * 1000; // 1 demande / 30s / IP
const MAX_PENDING = 25;                // file d'attente max
const lastByIp = new Map();

// File d'attente en memoire. id -> job
// status: 'pending' | 'processing' | 'done' | 'error'
const jobs = new Map();

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// Nettoyage : supprime les jobs de plus de 30 min + vieilles IP
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
  for (const [ip, ts] of lastByIp) if (ts < cutoff) lastByIp.delete(ip);
}, 5 * 60 * 1000);

function requireToken(req, res, next) {
  const t = req.get('x-token');
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function countPending() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'pending' || j.status === 'processing') n++;
  return n;
}

// --- Cote CLIENT ---------------------------------------------------------

app.post('/api/request', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const last = lastByIp.get(ip) || 0;
  if (now - last < REQUEST_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Tu viens déjà de faire une demande, patiente un instant.' });
  }
  if (countPending() >= MAX_PENDING) {
    return res.status(429).json({ error: 'Trop de demandes en ce moment, réessaie dans quelques minutes.' });
  }
  const pseudo = String(req.body.pseudo || '').trim().slice(0, 60);
  const id = newId();
  jobs.set(id, { id, pseudo, status: 'pending', createdAt: now });
  lastByIp.set(ip, now);
  console.log(`[${new Date().toISOString()}] Demande recue: ${id} (@${pseudo}) ip=${ip}`);
  res.json({ id });
});

app.get('/api/result/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ status: 'unknown' });
  if (j.status === 'done') return res.json({ status: 'done', url: j.url, login: j.login, password: j.password });
  if (j.status === 'error') return res.json({ status: 'error', error: j.error || 'echec' });
  res.json({ status: 'waiting' });
});

// --- Cote SCRIPT (Chrome d'Adel), protege par le jeton -------------------

app.get('/api/pending', requireToken, (_req, res) => {
  const out = [];
  for (const j of jobs.values()) {
    if (j.status === 'pending') {
      j.status = 'processing';
      j.processingAt = Date.now();
      out.push({ id: j.id, pseudo: j.pseudo });
    }
  }
  res.json({ jobs: out });
});

app.post('/api/result', requireToken, (req, res) => {
  const { id, login, password, url, error } = req.body || {};
  const j = jobs.get(id);
  if (!j) return res.status(404).json({ error: 'job introuvable' });
  if (error) {
    j.status = 'error';
    j.error = String(error).slice(0, 200);
  } else {
    j.status = 'done';
    j.login = login;
    j.password = password;
    j.url = url;
  }
  console.log(`[${new Date().toISOString()}] Resultat ${id}: ${j.status}${login ? ' login=' + login : ''}`);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, jobs: jobs.size }));

app.listen(PORT, () => {
  console.log(`File d'attente demarree sur le port ${PORT}`);
  if (!TOKEN) console.warn('ATTENTION: SCRIPT_TOKEN vide — le userscript ne pourra pas se connecter.');
});
