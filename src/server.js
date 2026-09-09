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

// Offres proposees. `paid: true` => passe par la validation manuelle d'Adel.
const OFFERS = {
  trial: { label: 'Essai 2 jours', duration: '2 jours', paid: false },
  new: { label: 'Nouveau compte', duration: '12 mois', paid: true },
};

// Anti-abus
const REQUEST_COOLDOWN_MS = 30 * 1000;
const MAX_ACTIVE = 30;
const lastByIp = new Map();

// File en memoire. id -> job
// status: 'awaiting_approval' | 'pending' | 'processing' | 'done' | 'error' | 'rejected'
const jobs = new Map();

const newId = () => crypto.randomBytes(9).toString('base64url');

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // garde 1h
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
  for (const [ip, ts] of lastByIp) if (ts < cutoff) lastByIp.delete(ip);
}, 5 * 60 * 1000);

function requireToken(req, res, next) {
  const t = req.get('x-token') || req.query.token;
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function activeCount() {
  let n = 0;
  for (const j of jobs.values())
    if (['awaiting_approval', 'pending', 'processing'].includes(j.status)) n++;
  return n;
}

// --- Cote CLIENT ---------------------------------------------------------

app.post('/api/request', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  if (now - (lastByIp.get(ip) || 0) < REQUEST_COOLDOWN_MS)
    return res.status(429).json({ error: 'Tu viens déjà de faire une demande, patiente un instant.' });
  if (activeCount() >= MAX_ACTIVE)
    return res.status(429).json({ error: 'Trop de demandes en ce moment, réessaie dans quelques minutes.' });

  const type = String(req.body.type || '');
  const offer = OFFERS[type];
  if (!offer) return res.status(400).json({ error: 'Type de demande invalide.' });

  const pseudo = String(req.body.pseudo || '').trim().slice(0, 60);
  const id = newId();
  jobs.set(id, {
    id, type, pseudo,
    duration: offer.duration,
    paid: offer.paid,
    status: offer.paid ? 'awaiting_approval' : 'pending',
    createdAt: now,
  });
  lastByIp.set(ip, now);
  console.log(`[${new Date().toISOString()}] Demande ${type} (${offer.duration}) : ${id} (@${pseudo}) ip=${ip}`);
  res.json({ id, paid: offer.paid });
});

app.get('/api/result/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ status: 'unknown' });
  if (j.status === 'done') return res.json({ status: 'done', url: j.url, login: j.login, password: j.password });
  if (j.status === 'error') return res.json({ status: 'error', error: j.error || 'echec' });
  if (j.status === 'rejected') return res.json({ status: 'rejected' });
  if (j.status === 'awaiting_approval') return res.json({ status: 'waiting_approval' });
  res.json({ status: 'waiting' });
});

// --- Cote SCRIPT (Chrome d'Adel), protege par le jeton -------------------

app.get('/api/pending', requireToken, (_req, res) => {
  const out = [];
  for (const j of jobs.values()) {
    if (j.status === 'pending') {
      j.status = 'processing';
      j.processingAt = Date.now();
      out.push({ id: j.id, type: j.type, pseudo: j.pseudo, duration: j.duration });
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

// --- Cote ADMIN (Adel), protege par le jeton -----------------------------

app.get('/api/admin/jobs', requireToken, (_req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((j) => ({
      id: j.id, type: j.type, pseudo: j.pseudo, duration: j.duration,
      paid: j.paid, status: j.status, login: j.login, password: j.password,
      url: j.url, createdAt: j.createdAt,
    }));
  res.json({ jobs: list });
});

app.post('/api/admin/approve', requireToken, (req, res) => {
  const j = jobs.get(req.body.id);
  if (!j) return res.status(404).json({ error: 'introuvable' });
  if (j.status !== 'awaiting_approval') return res.status(409).json({ error: 'déjà traité' });
  j.status = 'pending';
  console.log(`[${new Date().toISOString()}] VALIDE ${j.id} (@${j.pseudo}) ${j.duration}`);
  res.json({ ok: true });
});

app.post('/api/admin/reject', requireToken, (req, res) => {
  const j = jobs.get(req.body.id);
  if (!j) return res.status(404).json({ error: 'introuvable' });
  if (j.status !== 'awaiting_approval') return res.status(409).json({ error: 'déjà traité' });
  j.status = 'rejected';
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, jobs: jobs.size }));

app.listen(PORT, () => {
  console.log(`File d'attente demarree sur le port ${PORT}`);
  if (!TOKEN) console.warn('ATTENTION: SCRIPT_TOKEN vide — userscript & admin ne pourront pas se connecter.');
});
