/* ============================================================
   Gestion Scolaire — Serveur de synchronisation (Node/Express)
   ------------------------------------------------------------
   Rôle :
     - Réceptionner les "enregistrements de postes" émis par chaque
       instance de l'application (postId + comptes utilisateurs).
     - Agrégation pour la gestion à distance (liste des postes,
       comptes, directives de désactivation).
     - Les DONNÉES SCOLAIRES ne transitent JAMAIS ici : l'application
       les conserve localement (IndexedDB) et fonctionne hors ligne.

   Sécurité du panneau d'administration (admin.html) :
     - Authentification par MOT DE PASSE + SESSION (token signé).
     - Variable d'environnement ADMIN_PASSWORD : mot de passe maître.
     - Variable d'environnement SESSION_SECRET : clé de signature des
       jetons (générez une valeur longue et aléatoire).
     - POST /api/admin/login reçoit { password } et renvoie un jeton à
       passer dans le header "Authorization: Bearer <jeton>".
     - Toutes les routes /api/admin/* (sauf /login) exigent ce jeton.

   Déploiement : voir DEPLOIEMENT.md et server-node/README.md
   ============================================================ */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'posts.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-prod';
const SESSION_TTL_S = 8 * 60 * 60; // 8 heures

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// -------- Stockage JSON simple (aucune dépendance externe) --------
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { posts: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// -------- Sécurité : mot de passe + session (token signé) --------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url').toString('utf8');

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  try {
    const [h, b, s] = String(token).split('.');
    if (!h || !b || !s) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(h + '.' + b).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(b64urlDecode(b));
    if (!payload.exp || Date.now() > payload.exp * 1000) return null;
    return payload;
  } catch (e) { return null; }
}

function adminEnabled() {
  return !!ADMIN_PASSWORD;
}

// Middleware d'authentification des routes admin
function requireAuth(req, res, next) {
  if (!adminEnabled()) {
    return res.status(503).json({ ok: false, error: 'Admin désactivé : variable ADMIN_PASSWORD non définie.' });
  }
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token)) {
    return res.status(401).json({ ok: false, error: 'Non authentifié. Appelez POST /api/admin/login puis renvoyez le jeton dans Authorization: Bearer <token>.' });
  }
  next();
}

// Connexion administrateur
// POST /api/admin/login  { password }
app.post('/api/admin/login', (req, res) => {
  if (!adminEnabled()) {
    return res.status(503).json({ ok: false, error: 'Admin désactivé : variable ADMIN_PASSWORD non définie.' });
  }
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Mot de passe incorrect.' });
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const token = signToken({ sub: 'admin', iat: Math.floor(Date.now() / 1000), exp });
  res.json({ ok: true, token: token, expiresIn: SESSION_TTL_S });
});

// -------- Enregistrement périodique d'un poste --------
// POST /api/posts/register  (PUBLIC : appelé par l'application)
// Body : { postId, app, version, hostname, at, accounts:[...] }
// Réponse : { directives: [ {kind, accountId, note, at} ] }
app.post('/api/posts/register', (req, res) => {
  const body = req.body || {};
  const postId = String(body.postId || 'unknown');
  const db = loadDB();
  const now = new Date().toISOString();
  const existing = db.posts[postId] || { firstSeen: now, directives: {} };

  const record = {
    postId: postId,
    app: body.app || 'GestionScolaire',
    version: body.version || 1,
    hostname: body.hostname || '',
    lastSeen: now,
    firstSeen: existing.firstSeen,
    accounts: Array.isArray(body.accounts) ? body.accounts : []
  };
  db.posts[postId] = record;
  saveDB(db);

  // Retourne les directives en attente pour ce poste (gestion à distance).
  const dirs = Object.keys(existing.directives || {}).map((k) => existing.directives[k]);
  existing.directives = {}; // directives 'consommées'
  db.posts[postId].directives = existing.directives;
  saveDB(db);

  res.json({ ok: true, directives: dirs });
});

// -------- Gestion à distance (AUTHENTIFIÉ) --------
// POST /api/admin/:postId/deactivate  { accountId, note }
app.post('/api/admin/:postId/deactivate', requireAuth, (req, res) => {
  const postId = String(req.params.postId);
  const accountId = String(req.body && req.body.accountId);
  if (!accountId) return res.status(400).json({ ok: false, error: 'accountId requis' });
  const db = loadDB();
  if (!db.posts[postId]) return res.status(404).json({ ok: false, error: 'poste inconnu' });
  const key = 'deactivate_' + accountId;
  db.posts[postId].directives = db.posts[postId].directives || {};
  db.posts[postId].directives[key] = {
    kind: 'deactivate_user',
    accountId: accountId,
    note: (req.body && req.body.note) || 'Désactivé à distance',
    at: new Date().toISOString()
  };
  saveDB(db);
  res.json({ ok: true });
});

// -------- Consultation (vue admin) (AUTHENTIFIÉ) --------
// GET /api/admin/posts  → liste agrégée des postes et comptes
app.get('/api/admin/posts', requireAuth, (req, res) => {
  const db = loadDB();
  const list = Object.keys(db.posts).map((k) => ({
    postId: db.posts[k].postId,
    hostname: db.posts[k].hostname,
    lastSeen: db.posts[k].lastSeen,
    firstSeen: db.posts[k].firstSeen,
    nbComptes: (db.posts[k].accounts || []).length,
    comptes: (db.posts[k].accounts || []).map((a) => ({ id: a.id, username: a.username, nom: a.nom, role: a.role, actif: a.actif }))
  }));
  res.json({ ok: true, posts: list });
});

// -------- Santé (publié : utilisé par le healthcheck) --------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'gestionscolaire-sync', time: new Date().toISOString(), adminEnabled: adminEnabled() });
});

// (Optionnel) servir l'application statique si placée dans "public/"
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log('Serveur de synchronisation Gestion Scolaire démarré sur le port ' + PORT);
  console.log('  Registre : ' + DB_FILE);
  console.log('  Administration : ' + (adminEnabled() ? 'ACTIVÉE (ADMIN_PASSWORD définie)' : 'DÉSACTIVÉE (définir ADMIN_PASSWORD)'));
});
