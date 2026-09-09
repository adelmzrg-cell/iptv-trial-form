# IPTV Trial Form

Formulaire en ligne qui crée automatiquement des comptes d'essai IPTV.

## Comment ça marche

Le panel est protégé par Cloudflare, donc impossible de le piloter depuis un serveur.
La création se fait donc **dans le vrai navigateur du revendeur**, via un userscript
(Tampermonkey) qui contourne Cloudflare naturellement.

```
Client → formulaire (ce serveur) → file d'attente
                                        ↑ poll (jeton)
                        userscript dans le Chrome du revendeur → crée le compte sur le panel
                                        ↓ renvoie les accès
Client ← accès affichés ← ce serveur
```

- `src/server.js` : file d'attente + formulaire (déployé sur Coolify).
- `public/index.html` : la page vue par le client.
- `userscript.user.js` : modèle du script à installer dans le Chrome du revendeur
  (remplacer `__BACKEND__` et `__TOKEN__`).

## Déploiement (Coolify)

- Type : Nixpacks (Node). Commande de démarrage : `npm start`. Port : `3000`.
- Variable d'environnement requise : `SCRIPT_TOKEN` (un long jeton aléatoire).

## Installation du userscript

1. Installer l'extension **Tampermonkey** dans Chrome + activer « Autoriser les scripts
   utilisateur » (chrome://extensions → Mode développeur → Tampermonkey → Détails).
2. Copier `userscript.user.js`, remplacer `__BACKEND__` (URL Coolify) et `__TOKEN__`
   (= `SCRIPT_TOKEN`), l'ajouter dans Tampermonkey.
3. Garder un onglet `max.myirtv.net` ouvert et connecté → pastille « 🟢 Auto-essais actif ».
