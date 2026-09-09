// ==UserScript==
// @name         IPTV - Createur d'essais automatique
// @namespace    iptv-trial-form
// @version      0.1
// @description  Cree automatiquement les comptes d'essai demandes via le formulaire en ligne, depuis TA session (contourne Cloudflare).
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
  const POLL_MS = 5000;           // frequence de verification
  // =====================================================

  const PANEL = 'https://max.myirtv.net';
  const TRIAL_NBR = '6';        // "Essai gratuit de 2 jours"
  const CLIENT_URL = 'http://line.vtu726.org:8080';

  // Liste des bouquets (= bouton "Ajouter tout"), capturee sur le panel.
  const ALL_BOUQUETS = ["99","100","98","82","81","91","80","79","78","77","76","75","74","73","72","71","48","85","84","70","69","68","65","64","63","62","61","67","66","83","60","59","50","47","49","89","58","57","51","55","56","88","54","52","53"];

  // ---- petit badge visuel en bas a droite ----
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#111827;color:#e5e7eb;border:1px solid #22c55e;border-radius:10px;padding:8px 12px;font:13px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.4)';
  badge.textContent = '🟢 Auto-essais actif';
  document.addEventListener('DOMContentLoaded', () => document.body && document.body.appendChild(badge));
  if (document.body) document.body.appendChild(badge);
  function setBadge(t) { badge.textContent = t; }

  // ---- appels vers le backend (cross-origin) via GM_xmlhttpRequest ----
  function backend(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: BACKEND + path,
        headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (_) { resolve({}); }
        },
        onerror: reject,
        ontimeout: reject,
      });
    });
  }

  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    const a = crypto.getRandomValues(new Uint8Array(14));
    for (let i = 0; i < 14; i++) s += chars[a[i] % chars.length];
    return 'a' + s + '7'; // >= 12, avec lettre + chiffre
  }

  // Recupere la liste des bouquets depuis la page d'ajout (sinon liste par defaut).
  async function getBouquets() {
    try {
      const html = await (await fetch(PANEL + '/line/line/add', { credentials: 'include' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // le select source des bouquets (multi) : on prend les valeurs numeriques
      const selects = [...doc.querySelectorAll('select')];
      for (const sel of selects) {
        const vals = [...sel.options].map((o) => o.value).filter((v) => /^\d+$/.test(v));
        // heuristique : le select des bouquets a beaucoup d'options numeriques
        if (vals.length >= 10) return vals;
      }
    } catch (_) {}
    return ALL_BOUQUETS;
  }

  // Cree une ligne d'essai. Renvoie { login, password, url }.
  async function createTrial() {
    const password = genPassword();
    const bouquets = await getBouquets();

    const fd = new FormData();
    fd.append('login', '');
    fd.append('password', password);
    fd.append('nbr', TRIAL_NBR);
    fd.append('note', '');
    fd.append('bouquets2', bouquets[0]);
    fd.append('bouquets', JSON.stringify(bouquets));

    const res = await fetch(PANEL + '/line/line/insert', {
      method: 'POST',
      body: fd,
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    const data = await res.json();
    if (!data || !data.success || !data.insert_primary_key) {
      throw new Error('creation refusee par le panel');
    }
    const id = data.insert_primary_key;

    // lit l'identifiant genere sur la page d'edition
    let login = '';
    try {
      const ehtml = await (await fetch(PANEL + '/line/line/edit/' + id, { credentials: 'include' })).text();
      const edoc = new DOMParser().parseFromString(ehtml, 'text/html');
      login = (edoc.querySelector('input[name="login"]') || {}).value || '';
      if (!login) {
        const m = ehtml.match(/name=["']login["'][^>]*value=["']([^"']+)["']/i);
        if (m) login = m[1];
      }
    } catch (_) {}

    return { login: login.trim(), password, url: CLIENT_URL };
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const { jobs } = await backend('GET', '/api/pending');
      if (jobs && jobs.length) {
        for (const job of jobs) {
          setBadge('⏳ Création pour @' + (job.pseudo || '?'));
          try {
            const acc = await createTrial();
            await backend('POST', '/api/result', { id: job.id, ...acc });
            setBadge('✅ Créé : ' + (acc.login || 'ok'));
          } catch (e) {
            await backend('POST', '/api/result', { id: job.id, error: e.message });
            setBadge('⚠️ Échec (' + e.message + ')');
          }
        }
      } else {
        setBadge('🟢 Auto-essais actif');
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
