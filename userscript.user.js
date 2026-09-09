// ==UserScript==
// @name         IPTV - Createur de comptes automatique
// @namespace    iptv-trial-form
// @version      0.3
// @description  Cree/renouvelle les comptes (essai + abonnement + renouvellement) demandes via le formulaire en ligne, depuis TA session (contourne Cloudflare).
// @match        https://max.myirtv.net/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ======= A CONFIGURER (remplace ces 2 valeurs) =======
  const BACKEND = '__BACKEND__';  // URL de ton serveur, ex: https://essai.tondomaine.fr
  const TOKEN = '__TOKEN__';      // jeton secret, identique a SCRIPT_TOKEN du serveur
  const POLL_MS = 5000;
  // =====================================================

  const PANEL = 'https://max.myirtv.net';
  const CLIENT_URL = 'http://line.vtu726.org:8080';

  // Liste des bouquets (= bouton "Ajouter tout"), capturee sur le panel (secours).
  const ALL_BOUQUETS = ["99","100","98","82","81","91","80","79","78","77","76","75","74","73","72","71","48","85","84","70","69","68","65","64","63","62","61","67","66","83","60","59","50","47","49","89","58","57","51","55","56","88","54","52","53"];

  // --- badge visuel ---
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#111827;color:#e5e7eb;border:1px solid #22c55e;border-radius:10px;padding:8px 12px;font:13px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.4)';
  badge.textContent = '🟢 Auto-comptes actif';
  const attach = () => document.body && document.body.appendChild(badge);
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
  const setBadge = (t) => (badge.textContent = t);

  // --- backend (cross-origin) ---
  function backend(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: BACKEND + path,
        headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (_) { resolve({}); } },
        onerror: reject, ontimeout: reject,
      });
    });
  }

  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    const a = crypto.getRandomValues(new Uint8Array(14));
    for (let i = 0; i < 14; i++) s += chars[a[i] % chars.length];
    return 'a' + s + '7';
  }

  // Lit la page d'ajout une fois (bouquets + menu des durees).
  async function loadAddForm() {
    const html = await (await fetch(PANEL + '/line/line/add', { credentials: 'include' })).text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function getBouquets(doc) {
    for (const sel of doc.querySelectorAll('select')) {
      const vals = [...sel.options].map((o) => o.value).filter((v) => /^\d+$/.test(v));
      if (vals.length >= 10) return vals; // le select des bouquets
    }
    return ALL_BOUQUETS;
  }

  // Trouve le "nbr" correspondant a une duree (ex: "12 mois", "2 jours") dans le menu Temps.
  function getNbr(doc, duration) {
    // le select "Temps" : celui dont les options parlent de mois/jours/credit
    let temps = null;
    for (const sel of doc.querySelectorAll('select')) {
      if ([...sel.options].some((o) => /mois|jour|cr[ée]dit/i.test(o.textContent))) { temps = sel; break; }
    }
    const m = String(duration).toLowerCase().match(/(\d+)\s*(mois|jour|an)/);
    if (temps && m) {
      for (const o of temps.options) {
        const t = o.textContent.toLowerCase();
        if (t.includes(m[1]) && t.includes(m[2])) return o.value;
      }
    }
    if (/2\s*jours/i.test(duration)) return '6'; // secours essai gratuit
    throw new Error('durée introuvable: ' + duration);
  }

  // Creation (essai / abonnement) : POST /line/line/insert, login vide -> genere.
  async function createAccount(job) {
    const doc = await loadAddForm();
    const password = genPassword();
    const bouquets = getBouquets(doc);
    const nbr = getNbr(doc, job.duration);

    const fd = new FormData();
    fd.append('login', '');
    fd.append('password', password);
    fd.append('nbr', nbr);
    fd.append('note', '@' + (job.pseudo || '') + ' (' + job.duration + ')');
    fd.append('bouquets2', bouquets[0]);
    fd.append('bouquets', JSON.stringify(bouquets));

    const res = await fetch(PANEL + '/line/line/insert', {
      method: 'POST', body: fd, credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    const data = await res.json();
    if (!data || !data.success || !data.insert_primary_key) throw new Error('creation refusee par le panel');
    const id = data.insert_primary_key;

    let login = '';
    try {
      const ehtml = await (await fetch(PANEL + '/line/line/edit/' + id, { credentials: 'include' })).text();
      const edoc = new DOMParser().parseFromString(ehtml, 'text/html');
      login = (edoc.querySelector('input[name="login"]') || {}).value || '';
      if (!login) { const mm = ehtml.match(/name=["']login["'][^>]*value=["']([^"']+)["']/i); if (mm) login = mm[1]; }
    } catch (_) {}

    return { login: login.trim(), password, url: CLIENT_URL };
  }

  // Renouvellement : POST /line/lineexperied/insert avec l'identifiant + mdp existants.
  async function renewAccount(job) {
    const doc = await loadAddForm();
    const bouquets = getBouquets(doc);
    const nbr = getNbr(doc, job.duration);

    const fd = new FormData();
    fd.append('login', job.login);
    fd.append('password', job.password);
    fd.append('nbr', nbr);
    fd.append('note', 'renouvellement (' + job.duration + ')');
    fd.append('bouquets2', bouquets[0]);
    fd.append('bouquets', JSON.stringify(bouquets));

    const res = await fetch(PANEL + '/line/lineexperied/insert', {
      method: 'POST', body: fd, credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    const data = await res.json();
    if (!data || !data.success) throw new Error('renouvellement refuse (identifiant/mdp ?)');

    return { login: job.login, password: job.password, url: CLIENT_URL };
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const { jobs } = await backend('GET', '/api/pending');
      if (jobs && jobs.length) {
        for (const job of jobs) {
          setBadge('⏳ ' + (job.type === 'renew' ? 'renouv. ' + job.login : (job.duration || '') + ' @' + (job.pseudo || '?')));
          try {
            const acc = job.type === 'renew' ? await renewAccount(job) : await createAccount(job);
            await backend('POST', '/api/result', { id: job.id, ...acc });
            setBadge('✅ Créé : ' + (acc.login || 'ok'));
          } catch (e) {
            await backend('POST', '/api/result', { id: job.id, error: e.message });
            setBadge('⚠️ Échec (' + e.message + ')');
          }
        }
      } else {
        setBadge('🟢 Auto-comptes actif');
      }
    } catch (_) {
      setBadge('🔌 Serveur injoignable…');
    } finally {
      busy = false;
    }
  }

  setInterval(tick, POLL_MS);
  tick();
})();
