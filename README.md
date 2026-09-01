# Serveur de synchronisation Gestion Scolaire — déploiement Render (Node/Express)

Ce dossier contient un serveur **Node/Express** prêt pour **Render** :

- `server.js` — l'application (Express + CORS), stockage JSON simple.
- `package.json` — dépendances (`express`, `cors`) + script `start`.
- `Dockerfile` — image Node 20 alpine, volume `/app/data`, healthcheck.
- `render.yaml` — Blueprint Render (Web Service, runtime docker).
- `Procfile` — fallback pour d'autres hébergeurs.
- `.dockerignore` / `.gitignore` — excluent `node_modules` et `data`.

## Données scolaires : jamais ici

Ce serveur ne reçoit **que** l'identité des postes + comptes (pour la gestion à
distance). Les données scolaires restent locales (IndexedDB) dans chaque
instance.

## Étapes de déploiement sur Render

### Option A — Blueprint (render.yaml)

1. Poussez ce dossier dans un dépôt Git (GitHub/GitLab).
2. Sur Render : **New → Blueprint** → connectez le dépôt.
3. Le Web Service `gestionscolaire-sync` est créé automatiquement.
4. Notez l'URL, ex. `https://gestionscolaire-sync.onrender.com`.

### Option B — Web Service manuel

1. Sur Render : **New → Web Service** → connectez le dépôt.
2. Runtime : **Docker** (il utilise automatiquement le `Dockerfile`).
3. Name : `gestionscolaire-sync`. Plan : **Free** ou **Starter**.
4. **Create Web Service**. Après le build, notez l'URL.

> Sur le plan **Free**, Render coupe le service après inactivité ; à la
> relance les données du registre peuvent être réinitialisées (un plan
> **Starter+ avec un Disque** est conseillé pour un stockage stable — voir
> le `disk:` commenté dans `render.yaml`).

## Sécuriser le panneau d'administration (obligatoire avant mise en production)

Le panneau `admin.html` est protégé par **mot de passe + session**. Sur Render,
définissez deux **variables d'environnement** (Settings → Environment) :

| Variable | Rôle | Valeur conseillée |
|---|---|---|
| `ADMIN_PASSWORD` | Mot de passe maître pour se connecter au panneau | une longue chaîne aléatoire (voir génération ci-dessous) |
| `SESSION_SECRET` | Clé de signature des jetons de session | une longue chaîne aléatoire distincte |

Générez deux valeurs fortes, par exemple avec PowerShell :

```powershell
# 32 octets aléatoires → 43 caractères
-join ((1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Min 0 -Max 256) }))
```

Répétez deux fois : la 1ʳᵉ valeur va dans `ADMIN_PASSWORD`, la 2ᵉ dans `SESSION_SECRET`.

> **Important** : si `ADMIN_PASSWORD` n'est pas définie, l'administration est
> **désactivée** : `GET /api/admin/posts`, `POST /api/admin/*` et `POST /api/admin/login`
> renvoient `503`. `POST /api/posts/register` (l'application) reste toujours ouvert.

## Vérifier

Ouvrez dans un navigateur :

```
https://VOTRE-URL/api/health
```

Réponse attendue : `{"ok": true, "service": "gestionscolaire-sync", "adminEnabled": true, ...}`

## Connecter l'application statique

Dans le dossier statique déployé, ouvrez `index.html` et renseignez l'URL du
serveur (sans le `/api/health`) dans :

```html
<meta name="gs-sync-url" content="https://gestionscolaire-sync.onrender.com" />
```

Re-déployez le site statique. L'application s'enregistrera alors
périodiquement sur le serveur (états ● En ligne / ↻ / ○ Hors ligne dans la
barre supérieure) et les postes/comptes seront visibles sur `admin.html`.

Ouvrez `admin.html` (hébergé sur le site statique), indiquez l'adresse du
serveur, puis connectez-vous avec le **`ADMIN_PASSWORD`** défini plus haut.
La session (jeton signé) dure 8 h et survit à un rafraîchissement ; le bouton
« Se déconnecter » invalide la session locale.

## API

| Méthode | Route                            | Rôle                                          |
|---------|----------------------------------|-----------------------------------------------|
| POST    | `/api/posts/register`            | Enregistrement périodique d'un poste + comptes|
| GET     | `/api/admin/posts`               | Liste agrégée des postes et comptes           |
| POST    | `/api/admin/:postId/deactivate`  | Placer une directive de désactivation         |
| GET     | `/api/health`                    | Contrôle de santé                             |
