'use strict';
// ============================================================
// yapson-bot7-H-CP — Multi-utilisateurs
// Décaissement via app.connectpro.yapson.net (ConnectPro)
// Confirmation via my-managment.com (inchangé)
// 1 SEUL retrait par cycle — sans capture d'écran
// Polling status="success" max 2min avant confirmation
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const crypto   = require('crypto');
const { chromium } = require('playwright');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app  = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Firebase Firestore (persistance des comptes agents) ───────
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount && serviceAccount.project_id) {
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log('✅ Firebase Firestore connecté — comptes persistés');
  } else {
    console.error('⚠ FIREBASE_SERVICE_ACCOUNT manquant — persistance DÉSACTIVÉE (comptes en mémoire, perdus au redéploiement)');
  }
} catch(e) {
  console.error('❌ Firebase init échoué:', e.message, '— persistance désactivée');
  db = null;
}

let ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const MGMT_URL = (process.env.MGMT_URL || 'https://my-managment.com').replace(/\/$/, '');
// ── Alertes ntfy.sh ──────────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'YapsRt';
let _ntfyLastMsg = ''; let _ntfyLastTime = 0;
function sendNotif(title, msg, priority) {
  const now = Date.now();
  const key = title + msg;
  if (key === _ntfyLastMsg && now - _ntfyLastTime < 60000) return;
  _ntfyLastMsg = key; _ntfyLastTime = now;
  const https = require('https');
  const body = msg;
  const opts = {
    hostname: 'ntfy.sh',
    path: '/' + NTFY_TOPIC,
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': priority || 'default',
      'Tags': priority === 'urgent' ? 'rotating_light' : 'warning',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  const req = https.request(opts, (res) => {
    res.on('data', () => {});
    res.on('end', () => console.log('[NTFY] Alerte envoyée:', res.statusCode));
  });
  req.on('error', (e) => console.error('[NTFY] Erreur envoi:', e.message));
  req.write(body);
  req.end();
}

// ── Sessions ──────────────────────────────────────────────────
const sessions = {};
function createSession(userId, isAdmin) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, isAdmin, expires: Date.now() + 10*365*24*3600*1000 }; // 10 ans
  return token;
}
function getSession(req) {
  const m = (req.headers.cookie||'').match(/session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  return s;
}
function requireLogin(req, res, next) { const s=getSession(req); if(!s) return res.redirect('/login'); req.session=s; next(); }
function requireAdmin(req, res, next) { const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login'); req.session=s; next(); }

// ── Stockage utilisateurs ─────────────────────────────────────
const users = {};
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

function buildUser(id, username, passwordHash) {
  return {
    id, username, passwordHash,
    cfg: {
      mgmtCookies    : '',
      connectproToken: '',
      yapsonToken    : '',
      platforms      : { WAVE: 'connectpro', ORANGE: 'connectpro' },
      reportId       : process.env.REPORT_ID || '8231c3be3216307da83c067d263c09ec',
      pollInterval   : parseInt(process.env.POLL_INTERVAL || '600'),
      maxSolde       : parseInt(process.env.MAX_SOLDE || '0'),
    },
    stats: { confirmed:0, missing:0, fixed:0, polls:0, rejected:0 },
    logs: [],
    blacklist: new Set(),
    pollTimer: null, isRunning: false, botActive: false,
    // Navigateur intégré (login manuel iPad/mobile)
    loginBrowser: null, loginPage: null, loginScreenshot: null,
  };
}

function createUser(username, password) {
  const id = crypto.randomBytes(8).toString('hex');
  const u = buildUser(id, username, hashPass(password));
  users[id] = u;
  saveUser(u);
  return u;
}

// ── Persistance Firebase ──────────────────────────────────────
async function saveUser(u) {
  if (!db || !u) return;
  try {
    await db.collection('bot7h_users').doc(u.id).set({
      id: u.id, username: u.username, passwordHash: u.passwordHash,
      cfg: u.cfg, botActive: !!u.botActive,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch(e) { console.error(`[Firebase] saveUser: ${e.message}`); }
}

async function deleteUserFromDB(userId) {
  if (!db) return;
  try { await db.collection('bot7h_users').doc(userId).delete(); }
  catch(e) { console.error(`[Firebase] deleteUser: ${e.message}`); }
}

async function loadUsersFromDB() {
  if (!db) return;
  try {
    const snap = await db.collection('bot7h_users').get();
    let count = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const u = buildUser(d.id, d.username, d.passwordHash);
      if (d.cfg) u.cfg = { ...u.cfg, ...d.cfg };
      users[u.id] = u;
      count++;
      if (d.botActive) { try { startPolling(u); } catch(e){ console.error('resume:', e.message); } }
    }
    console.log(`✅ ${count} compte(s) agent chargé(s) depuis Firebase`);
  } catch(e) { console.error(`[Firebase] loadUsers: ${e.message}`); }
}

async function saveAdminPass(newPass) {
  if (!db) return;
  try { await db.collection('bot7h_config').doc('admin').set({ password: newPass }, { merge: true }); }
  catch(e) { console.error(`[Firebase] saveAdminPass: ${e.message}`); }
}

async function loadAdminPass() {
  if (!db) return;
  try {
    const doc = await db.collection('bot7h_config').doc('admin').get();
    if (doc.exists && doc.data().password) { ADMIN_PASS = doc.data().password; console.log('✅ Mot de passe admin chargé depuis Firebase'); }
  } catch(e) { console.error(`[Firebase] loadAdminPass: ${e.message}`); }
}

function ulog(u, type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  u.logs.unshift({ ts, type, msg });
  if (u.logs.length > 500) u.logs.pop();
  console.log('['+u.username+']['+type.toUpperCase()+'] '+ts+' — '+msg);
  if (type === 'err') {
    sendNotif('Bot7-H ERREUR [' + u.username + ']', msg.substring(0,300), 'urgent');
  } else if (type === 'warn') {
    sendNotif('Bot7-H ALERTE [' + u.username + ']', msg.substring(0,300), 'high');
  }
}

// ── Mapping réseau (UUIDs ConnectPro) ────────────────────────
const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};
function detectNetwork(title) {
  const t = (title||'').toLowerCase();
  if (t.includes('wave'))   return 'Wave';
  if (t.includes('mtn'))    return 'MTN CI';
  if (t.includes('moov'))   return 'MOOV CI';
  if (t.includes('orange')) return 'Orangeint';
  return 'Orangeint';
}

// ── Utilitaires ───────────────────────────────────────────────
function parseCookies(raw) {
  if (!raw) return '';
  let s = raw.trim().replace(/^\([^)]*\)\s*/,'').replace(/^[^[a-zA-Z]+/,'').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter(c=>c.name&&c.value!==undefined)
        .map(c=>c.name.trim()+'='+String(c.value).replace(/[\r\n\t]/g,'').replace(/[^\x20-\x7E]/g,'').trim()).join('; ');
    } catch(e) {}
  }
  return s.replace(/[\r\n]/g,'').trim();
}

function mgmtH(u) {
  return {
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'X-Time-Zone'      : 'GMT+00',
    'Cookie'           : parseCookies(u.cfg.mgmtCookies),
    'User-Agent'       : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'          : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
  };
}

// Headers ConnectPro (JWT Bearer)
function cpH(u) {
  return {
    'Content-Type' : 'application/json',
    'Authorization': `Bearer ${u.cfg.connectproToken}`,
  };
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Lire tous les retraits (my-managment) ────────────────────
async function getAllWithdrawals(u) {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method:'POST', headers:mgmtH(u), body:JSON.stringify({page:1,limit:500}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — cookies expirés ?`);
  const data = await res.json();
  if (data.is_guest) throw new Error('Session expirée — injecter nouveaux cookies');
  const rows = data.data || [];
  const groups = {};
  for (const row of rows) {
    const montant = row.summa_sort || parseInt((row.summa||'').replace(/[^0-9]/g,''))||0;
    const phone   = row.dopparam?.[0]?.description || '';
    const netTitle= row.dopparam?.[0]?.title || '';
    const pm      = String(phone).match(/0[0-9]{9}/);
    const cd      = row.confirm?.[0]?.data || null;
    const sid     = cd?.subagent_id;
    const subagentName = row.subagent || `Fournisseur_${sid}`;
    if (!pm || montant <= 0 || !cd || !sid) continue;
    if (u.blacklist && u.blacklist.has(pm[0])) { ulog(u,'info',`  ⏭ ${pm[0]} ignoré (blacklist)`); continue; }
    if (!groups[sid]) groups[sid] = { subagent_id:sid, subagentName, netTitle, network:detectNetwork(netTitle), items:[] };
    groups[sid].items.push({ phone:pm[0], montant, confirmData:cd, netTitle });
  }
  return groups;
}

// ── Décaissement ConnectPro ───────────────────────────────────
// POST https://connect.yapson.net/api/payments/user/transactions/
// Body: {"type":"deposit","amount":X,"recipient_phone":"0XXXXXXXXX","network":"UUID","objet":null}
// Réponse: {"success":true,"message":"...","data":{"uid":"xxx-xxx",...}}
async function payout(u, item, network) {
  const uuid = NET_UUIDS[network] || NET_UUIDS['Orangeint'];
  const body = { type:'deposit', amount:item.montant, recipient_phone:item.phone, network:uuid, objet:null };
  ulog(u, 'info', `  📤 ConnectPro → ${item.phone} — ${item.montant} FCFA [${network}]`);
  const res = await fetch('https://connect.yapson.net/api/payments/user/transactions/', {
    method:'POST', headers:cpH(u), body:JSON.stringify(body),
  });
  const respBody = await res.json().catch(()=>({}));
  ulog(u, 'info', `  🔍 Réponse [${res.status}]: ${JSON.stringify(respBody).substring(0,200)}`);
  if (res.status === 200 || res.status === 201) {
    // ConnectPro retourne: {"success":true,"data":{"uid":"xxx","type":"deposit",...}}
    const d = respBody.data || respBody;
    const txId = d.uid || d.id || d.reference || null;
    ulog(u, 'info', `  🆔 txId: ${txId}`);
    return { ok:true, txId, phone:item.phone, montant:item.montant };
  }
  if (res.status === 401) return { ok:false, err:'Token ConnectPro expiré', tokenExpired:true };
  return { ok:false, err:`[${res.status}] ${JSON.stringify(respBody).substring(0,100)}` };
}

// ── Attendre status="success" (polling ConnectPro) ────────────
// GET https://connect.yapson.net/api/payments/user/transactions/{uid}/
// Champ: tx.status === "success"
// tx.network est un objet {uid, nom, code, ...}
async function waitForSuccess(u, txId, phone, maxWait=120000) {
  const start = Date.now();
  function normalizePhone(p) {
    const s = String(p||'').replace(/[^0-9]/g,'');
    if (s.startsWith('225')) return s.substring(3);
    return s.length === 10 ? s : s;
  }
  const phoneNorm = normalizePhone(phone);

  while (Date.now() - start < maxWait) {
    await sleep(5000);
    if (Date.now() - start >= maxWait) break;
    try {
      let tx = null;
      if (txId) {
        // GET direct par uid — retourne l'objet sans wrapper
        const res = await fetch(`https://connect.yapson.net/api/payments/user/transactions/${txId}/`, {
          headers: cpH(u),
        });
        if (res.status === 401) { ulog(u, 'err', '  ⚠ Token ConnectPro expiré'); break; }
        tx = await res.json().catch(()=>null);
      } else {
        // Fallback: liste récente, chercher par téléphone
        const res = await fetch('https://connect.yapson.net/api/payments/user/transactions/?limit=50', {
          headers: cpH(u),
        });
        const raw = await res.json().catch(()=>({}));
        const list = Array.isArray(raw) ? raw : (raw.data || raw.results || []);
        tx = list.find(t => normalizePhone(t.recipient_phone||'') === phoneNorm);
      }
      if (!tx) { ulog(u, 'info', `  ⏳ Transaction introuvable pour ${phone}... (${Math.round((Date.now()-start)/1000)}s)`); continue; }

      const status = (tx.status||'').toLowerCase().trim();
      ulog(u, 'info', `  ⏳ ${String(txId||phone).substring(0,10)} status=${status}... (${Math.round((Date.now()-start)/1000)}s)`);

      // API ConnectPro retourne status="success" en anglais minuscule
      if (status === 'success') return { ok:true, tx };
      if (status === 'failed' || status === 'rejected' || status === 'cancelled') {
        return { ok:false, err:`Transaction ${status}: ${tx.error_message||''}`, skip:true };
      }
      // Statuts intermédiaires: pending, processing, sent_to_user → continuer à attendre

    } catch(e) {
      ulog(u, 'info', `  ⏳ attente... (${Math.round((Date.now()-start)/1000)}s)`);
    }
  }
  return { ok:false, err:`Timeout 2min — ${phone} ignoré`, skip:true };
}

// ── Confirmation sans fichier (my-managment) ─────────────────
async function confirmWithoutFile(u, item) {
  const cd = item.confirmData;
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(u), body:JSON.stringify({id:cd.subagent_id,ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);
  const fd = new FormData();
  fd.append('code',cd.code||'epay'); fd.append('id',String(cd.id));
  fd.append('comment',''); fd.append('commentId','null'); fd.append('otherComment','');
  fd.append('is_out','true'); fd.append('subagent_id',String(cd.subagent_id));
  fd.append('ref_id',String(cd.ref_id||1)); fd.append('bank_id',cd.bank_id?String(cd.bank_id):'null');
  fd.append('report_id',u.cfg.reportId); fd.append('user_id',String(cd.user_id||''));
  const h = {
    'Accept':'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest',
    'X-Time-Zone':'GMT+00','Cookie':parseCookies(u.cfg.mgmtCookies),
    'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer':'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
    ...fd.getHeaders(),
  };
  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney',{method:'POST',headers:h,body:fd});
  if (res.status===200||res.status===302) {
    const text = await res.text();
    ulog(u,'info',`  🔍 Confirm [${res.status}]: ${text.substring(0,200).replace(/\n/g,' ')}`);
    if (text.startsWith('<')||text.includes('<!DOCTYPE')) return {ok:true};
    try { const j=JSON.parse(text); return {ok:j.success===true,err:j.message||''}; } catch(e){return {ok:true};}
  }
  const et = await res.text().catch(()=>'');
  return {ok:false,err:`HTTP ${res.status} — ${et.substring(0,80)}`};
}

// ── Cycle principal — 1 seul retrait par cycle ────────────────
// ── yapson-transfer : décaissement APP (Wave/Orange) via appareil ─
const YAPSON_URL = (process.env.YAPSON_URL || 'https://yapson-transfer-production.up.railway.app').replace(/\/$/,'');
// WAVE / ORANGE : connectpro (défaut) | yapson. MTN/Moov : connectpro (inchangé).
function choosePlatform(u, operator) {
  const sel = (u.cfg.platforms && u.cfg.platforms[operator]) || '';
  if (operator === 'WAVE'   && (sel === 'yapson' || sel === 'yapson_perso') && u.cfg.yapsonToken) return 'yapson';
  if (operator === 'ORANGE' && sel === 'yapson' && u.cfg.yapsonToken) return 'yapson';
  return 'connectpro';
}
async function createYapsonPayout(u, { operator, amount, phone, recipientName, ref }) {
  try {
    const res = await fetch(`${YAPSON_URL}/api/ext/payout`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-agent-token':u.cfg.yapsonToken },
      body: JSON.stringify({ operator, amount, phoneNumber:phone, recipientName, clientRef:ref }),
    });
    const j = await res.json().catch(()=>({}));
    if (res.ok && j.ok) return { ok:true, id:j.id, reference:j.reference, status:j.status };
    return { ok:false, err:`[${res.status}] ${j.error||''}` };
  } catch(e) { return { ok:false, err:e.message }; }
}
async function pollYapson(u, id, maxWait=240000) {
  const start = Date.now();
  while (Date.now()-start < maxWait) {
    await sleep(6000);
    try {
      const res = await fetch(`${YAPSON_URL}/api/ext/payout/${id}`, { headers:{ 'x-agent-token':u.cfg.yapsonToken } });
      const j = await res.json().catch(()=>({}));
      if (!res.ok) { ulog(u,'info',`  ⏳ yapson HTTP ${res.status}...`); continue; }
      const st = String(j.status||'').toUpperCase();
      if (st==='SUCCESS') return { ok:true, status:st, operatorRef:j.operatorRef };
      if (st==='FAILED')  return { ok:false, status:st, err:j.error||'échec' };
      ulog(u,'info',`  ⏳ yapson ${st}... (${Math.round((Date.now()-start)/1000)}s)`);
    } catch(e) { ulog(u,'info',`  ⏳ yapson attente... (${Math.round((Date.now()-start)/1000)}s)`); }
  }
  return { ok:false, status:'TIMEOUT', err:'Timeout yapson' };
}
// Traite un retrait via yapson-transfer puis confirme my-managment (sans fichier, comme bot7-H).
async function handleYapsonItem(u, item, operator) {
  ulog(u,'info',`  🟢 yapson-transfer → ${item.phone} — ${item.montant.toLocaleString()} FCFA [${operator}]`);
  const recipientName = (operator === 'WAVE' || operator === 'WAVE_PERSO') ? (item.recipientName || null) : null;
  const created = await createYapsonPayout(u, { operator, amount:item.montant, phone:item.phone, recipientName, ref:String(item.confirmData?.id||'') });
  if (!created.ok) { u.stats.missing++; ulog(u,'err',`  ✘ yapson création échouée: ${item.phone} — ${created.err}`); return; }
  ulog(u,'ok',`  ✔ Ordre yapson créé: ${item.phone} (ref ${created.reference})`);
  const w = await pollYapson(u, created.id, 240000);
  if (!w.ok) {
    u.stats.missing++;
    if (!u.blacklist) u.blacklist = new Set();
    u.blacklist.add(item.phone);
    ulog(u,'warn',`  ⛔ ${item.phone} blacklisté — yapson ${w.status||''} ${w.err||''}`);
    return;
  }
  ulog(u,'ok',`  ✔ yapson SUCCESS: ${item.phone}${w.operatorRef?' (réf '+w.operatorRef+')':''}`);
  await sleep(500);
  const cr = await confirmWithoutFile(u, item);
  if (cr.ok) { u.stats.confirmed++; ulog(u,'ok',`  ✔ Confirmé: ${item.phone}`); }
  else { u.stats.missing++; ulog(u,'warn',`  ⚠ Confirmation échouée: ${item.phone} — ${cr.err}`); }
}

async function runCycle(u) {
  if (u.isRunning) return;
  u.isRunning = true; u.stats.polls++;
  ulog(u,'info',`━━ Poll #${u.stats.polls} ━━`);
  try {
    if (!parseCookies(u.cfg.mgmtCookies)) throw new Error('Cookies my-managment manquants');
    if (!u.cfg.connectproToken && !u.cfg.yapsonToken) throw new Error('Configurez ConnectPro et/ou yapson-transfer');

    const groups    = await getAllWithdrawals(u);
    const groupList = Object.values(groups);
    if (!groupList.length) { ulog(u,'info','0 retrait en attente'); u.isRunning=false; return; }
    ulog(u,'info',`${groupList.length} fournisseur(s) — ${groupList.map(g=>`${g.subagentName.substring(0,20)}(${g.items.length})`).join(', ')}`);

    // Bot7-H : 1 SEUL retrait par cycle
    let processed = false;
    for (const group of groupList) {
      if (processed) break;
      const { subagentName, network, items } = group;
      ulog(u,'info',`▶ ${subagentName} | ${network} | ${items.length} retrait(s)`);

      for (const item of items) {
        if (processed) break;
        ulog(u,'info',`  → ${item.phone} — ${item.montant.toLocaleString()} FCFA [${network}]`);

        // 0. Choix de plateforme par opérateur (Wave/Orange → yapson si configuré, sinon ConnectPro)
        const operator = network === 'Wave' ? 'WAVE' : ((network === 'Orangeint' || network === 'ORANGE CI') ? 'ORANGE' : null);
        if (operator && choosePlatform(u, operator) === 'yapson') {
          const yapsonOperator = (operator === 'WAVE' && u.cfg.platforms && u.cfg.platforms.WAVE === 'yapson_perso') ? 'WAVE_PERSO' : operator;
          await handleYapsonItem(u, item, yapsonOperator);
          processed = true; break;
        }

        // 1. Décaisser via ConnectPro
        const payResult = await payout(u, item, network);
        if (!payResult.ok) {
          u.stats.missing++;
          ulog(u,'err',`  ✘ Décaissement échoué: ${item.phone} — ${payResult.err}`);
          if (payResult.tokenExpired) {
            ulog(u,'err','  🔑 Token ConnectPro expiré — arrêt du cycle');
            u.isRunning = false; return;
          }
          processed = true; break;
        }
        ulog(u,'ok',`  ✔ Décaissé: ${item.phone} → ${item.montant.toLocaleString()} FCFA (uid: ${String(payResult.txId||'?').substring(0,10)})`);

        // 2. Attendre status="success" (max 2min)
        ulog(u,'info',`  ⏳ Attente status=success pour ${item.phone} (max 2min)...`);
        const waitResult = await waitForSuccess(u, payResult.txId, item.phone, 600000);

        if (!waitResult.ok) {
          u.stats.missing++;
          if (!u.blacklist) u.blacklist = new Set();
          u.blacklist.add(item.phone);
          ulog(u,'warn',`  ⛔ ${item.phone} ajouté à la blacklist — ${waitResult.err}`);
          processed = true; break;
        }
        ulog(u,'ok',`  ✔ Transaction SUCCESS: ${String(waitResult.tx?.uid||waitResult.tx?.id||'?').substring(0,10)}`);

        // 3. Confirmer sur my-managment
        await sleep(500);
        const confirmResult = await confirmWithoutFile(u, item);
        if (confirmResult.ok) {
          u.stats.confirmed++;
          ulog(u,'ok',`  ✔ Confirmé: ${item.phone}`);
        } else {
          u.stats.missing++;
          ulog(u,'warn',`  ⚠ Confirmation échouée: ${item.phone} — ${confirmResult.err}`);
        }
        processed = true;
        ulog(u,'info',`  ⏸ 1 retrait traité — prochain dans ${u.cfg.pollInterval}s`);
      }
    }
    if (!processed) ulog(u,'info','Aucun retrait traité');
    else ulog(u,'info',`Cycle terminé — ${u.stats.confirmed} confirmés total`);
  } catch(e) {
    ulog(u,'err',`Erreur: ${e.message}`); u.stats.rejected++;
  } finally { u.isRunning=false; }
}

function startPolling(u) {
  if (u.pollTimer) return; u.botActive=true;
  ulog(u,'ok',`Bot démarré — ${u.cfg.pollInterval}s`);
  runCycle(u); u.pollTimer=setInterval(()=>runCycle(u),u.cfg.pollInterval*1000);
}
function stopPolling(u) {
  if (u.pollTimer) { clearInterval(u.pollTimer); u.pollTimer=null; }
  u.botActive=false; ulog(u,'warn','Bot arrêté');
}

// ── CSS ───────────────────────────────────────────────────────
const CSS = `
:root{--bg:#0d1117;--s1:#161b22;--s2:#21262d;--s3:#30363d;--t:#e6edf3;--m:#8b949e;--g:#3fb950;--b:#58a6ff;--o:#f0883e;--r:#f85149;--p:#bc8cff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);font-family:'Courier New',monospace;color:var(--t);font-size:13px;padding:20px}
.wrap{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--s1);border:1px solid var(--s3);border-radius:10px;overflow:hidden}
.ch{padding:12px 16px;border-bottom:1px solid var(--s3);font-size:10px;font-weight:700;letter-spacing:2px;color:var(--m);text-transform:uppercase;display:flex;align-items:center;gap:8px}
.cb{padding:16px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.frow{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
label{font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--m);text-transform:uppercase}
input,select,textarea{width:100%;background:var(--s2);border:1px solid var(--s3);color:var(--t);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--b)}
.btn{padding:9px 18px;border-radius:7px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;border:none;text-decoration:none;display:inline-block}
.btn-save{background:rgba(88,166,255,.15);color:var(--b);border:1px solid rgba(88,166,255,.4)}
.btn-go{background:rgba(63,185,80,.2);color:var(--g);border:1px solid rgba(63,185,80,.4)}
.btn-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35)}
.btn-gray{background:var(--s2);color:var(--m);border:1px solid var(--s3)}
.btn-red{background:rgba(248,81,73,.8);color:#fff;border:none}
.btn-purple{background:rgba(188,140,255,.8);color:#fff;border:none}
.btn:hover{filter:brightness(1.15)}.btns{display:flex;gap:8px;flex-wrap:wrap}
.statbar{display:flex;gap:8px;flex-wrap:wrap}
.sc{background:var(--s1);border:1px solid var(--s3);border-radius:10px;padding:12px 20px;min-width:90px;text-align:center;flex:1}
.sv{font-size:28px;font-weight:700;line-height:1}.sl{font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.sc.vc .sv{color:var(--g)}.sc.vm .sv{color:var(--o)}.sc.vp .sv{color:var(--p)}.sc.vr .sv{color:var(--r)}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700}
.badge .dot{width:7px;height:7px;border-radius:50%}
.b-on{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3)}
.b-on .dot{background:var(--g);animation:pulse 1.8s infinite}
.b-off{background:rgba(139,148,158,.1);color:var(--m);border:1px solid rgba(139,148,158,.2)}
.b-off .dot{background:var(--m)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log{background:#0d1117;border-radius:7px;max-height:400px;overflow-y:auto;padding:8px;font-size:10px;line-height:1.9;word-break:break-word}
.le{display:flex;gap:10px}.lt{color:var(--m);min-width:135px;flex-shrink:0}
.ok span:last-child{color:var(--g)}.er span:last-child{color:var(--r)}.wa span:last-child{color:var(--o)}.in span:last-child{color:var(--b)}
.tag-ok{display:inline-block;background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tag-err{display:inline-block;background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tbl{width:100%;border-collapse:collapse;font-size:11px}
.tbl th{background:var(--s2);padding:7px;text-align:left;color:var(--b)}
.tbl td{padding:6px 7px;border-bottom:1px solid var(--s3)}
.seclbl{font-size:11px;font-weight:700;margin-bottom:10px}
.info-box{background:rgba(88,166,255,.07);border:1px solid rgba(88,166,255,.2);border-radius:8px;padding:10px 14px;font-size:10px;color:var(--b);margin-bottom:10px;line-height:1.8}
`;

// ── Pages HTML ────────────────────────────────────────────────
function loginPage(err='') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H-CP</title>
<style>${CSS}.box{max-width:380px;margin:80px auto;background:var(--s1);border:1px solid var(--s3);border-radius:12px;padding:28px}
h1{color:var(--p);font-size:1.2rem;margin-bottom:20px;text-align:center}</style></head>
<body><div class="box"><h1>🤖 YapsonBot7-H-CP</h1>
${err?`<div style="color:var(--r);font-size:11px;margin-bottom:10px">✘ ${err}</div>`:''}
<form method="POST" action="/login">
<div class="frow"><label>Utilisateur</label><input type="text" name="username" required></div>
<div class="frow"><label>Mot de passe</label><input type="password" name="password" required></div>
<button class="btn btn-go" style="width:100%;margin-top:8px">Connexion</button>
</form></div></body></html>`;
}

function userPage(u) {
  const logHtml = u.logs.slice(0,120).map(e=>{
    const cls=e.type==='ok'?'ok':e.type==='err'?'er':e.type==='warn'?'wa':'in';
    const ic =e.type==='ok'?'✔':e.type==='err'?'✘':e.type==='warn'?'⚠':'▸';
    return `<div class="le ${cls}"><span class="lt">${e.ts}</span><span>${ic} ${e.msg}</span></div>`;
  }).join('');
  const hasSession = parseCookies(u.cfg.mgmtCookies).length > 20;
  const hasNav = u.loginBrowser && u.loginBrowser.isConnected() && u.loginPage && !u.loginPage.isClosed();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H-CP — ${u.username}</title>
<style>${CSS}</style>
<script>if(${JSON.stringify(u.botActive)}) setTimeout(()=>location.reload(),15000);</script>
</head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🤖 ${u.username} <span style="font-size:10px;color:var(--m)">Bot7-H-CP — 1 retrait/cycle</span></div>
  <a href="/logout" class="btn btn-gray" style="font-size:10px">Déconnexion</a>
</div>
<div class="statbar">
<div class="sc vc"><div class="sv">${u.stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${u.stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vp"><div class="sv">${u.stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vr"><div class="sv">${u.stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>
<div class="card" style="border:2px solid var(--g)"><div class="ch" style="color:var(--g)">🌐 CONNEXION VIA NAVIGATEUR INTÉGRÉ (iPad / mobile)</div><div class="cb">
<div style="font-size:11px;color:var(--m);margin-bottom:10px">Connecte-toi à my-managment.com sans extraire les cookies manuellement.</div>
<div class="btns">
<a href="/user/browser" class="btn btn-go">🌐 Ouvrir navigateur</a>
${hasNav?`<form method="POST" action="/user/browser/close" style="display:inline"><button class="btn btn-stop">✕ Fermer</button></form><span style="font-size:11px;color:var(--g);margin-left:8px">● Navigateur actif</span>`:`<span style="font-size:11px;color:var(--m)">● Navigateur fermé</span>`}
</div>
</div></div>
<div class="card"><div class="ch">🔑 COMPTES</div><div class="cb">
<div class="info-box">
  <strong>ConnectPro</strong> — Récupérer le token sur <code>app.connectpro.yapson.net</code> :<br>
  F12 → Application → LocalStorage → copier <strong>accessToken</strong>
</div>
<form method="POST" action="/user/save-accounts"><div class="g2">
<div><div class="seclbl" style="color:var(--b)">app.connectpro.yapson.net</div>
<div class="frow"><label>Token ConnectPro (accessToken)</label>
<input type="password" name="connectproToken" value="${u.cfg.connectproToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${u.cfg.connectproToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div>
<div class="seclbl" style="color:var(--g);margin-top:10px">yapson-transfer (Wave / Orange via appareil)</div>
<div class="frow"><label>Jeton agent yapson-transfer</label>
<input type="password" name="yapsonToken" value="${u.cfg.yapsonToken?'●'.repeat(20):''}" placeholder="yat_...">
${u.cfg.yapsonToken?'<span class="tag-ok">✓ Actif</span>':'<span class="tag-err">✗ non configuré</span>'}
</div>
<div class="frow"><label>Plateforme par opérateur</label>
<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:12px">
<span>Wave : <select name="platWave" style="padding:5px 8px;border-radius:6px">
<option value="connectpro"${(u.cfg.platforms&&(u.cfg.platforms.WAVE==='yapson'||u.cfg.platforms.WAVE==='yapson_perso'))?'':' selected'}>ConnectPro</option>
<option value="yapson"${(u.cfg.platforms&&u.cfg.platforms.WAVE==='yapson')?' selected':''}>yapson — Wave business</option>
<option value="yapson_perso"${(u.cfg.platforms&&u.cfg.platforms.WAVE==='yapson_perso')?' selected':''}>yapson — Wave personnel</option>
</select></span>
<span>Orange : <select name="platOrange" style="padding:5px 8px;border-radius:6px">
<option value="connectpro"${(u.cfg.platforms&&u.cfg.platforms.ORANGE==='yapson')?'':' selected'}>ConnectPro</option>
<option value="yapson"${(u.cfg.platforms&&u.cfg.platforms.ORANGE==='yapson')?' selected':''}>yapson-transfer</option>
</select></span>
</div>
<div style="font-size:10px;color:var(--m);margin-top:6px">MTN / Moov restent sur ConnectPro. yapson-transfer nécessite le jeton ci-dessus.</div>
</div></div>
<div><div class="seclbl" style="color:var(--g)">my-managment.com</div>
<div class="frow"><label>Cookies de session</label>
<textarea name="mgmtCookies" rows="3" placeholder='[{"name":"auid",...}] ou PHPSESSID=...'></textarea>
${hasSession?'<span class="tag-ok">✓ Session active</span>':'<span class="tag-err">✗ Requis</span>'}
</div></div></div>
<div style="margin-top:14px"><button class="btn btn-save">💾 Sauvegarder</button></div>
</form></div></div>
<div class="card"><div class="ch">⚙️ CONFIGURATION</div><div class="cb">
<form method="POST" action="/user/save-config">
<div class="frow"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<span style="font-size:11px;color:var(--m)">Intervalle :</span>
<input type="number" name="pollInterval" value="${u.cfg.pollInterval}" min="60" max="86400" style="width:90px">
<span style="font-size:11px;color:var(--m)">s</span>
<span style="font-size:11px;color:var(--m);margin-left:16px">Solde max :</span>
<input type="number" name="maxSolde" value="${u.cfg.maxSolde}" min="0" style="width:120px">
<span style="font-size:11px;color:var(--m)">FCFA (0=illimité)</span>
</div></div>
<div style="margin-top:14px"><button class="btn btn-save">💾 Appliquer</button></div>
</form></div></div>
<div class="card"><div class="ch">▶ CONTRÔLES</div><div class="cb">
<span class="${u.botActive?'badge b-on':'badge b-off'}"><span class="dot"></span>${u.botActive?'Actif — toutes les '+u.cfg.pollInterval+'s':'Arrêté'}</span>
<div class="btns" style="margin-top:14px">
<a class="btn ${u.botActive?'btn-gray':'btn-go'}" href="/user/start">▶ Démarrer</a>
<a class="btn ${u.botActive?'btn-stop':'btn-gray'}" href="/user/stop">■ Arrêter</a>
<a class="btn btn-gray" href="/user/run">↻ Cycle manuel</a>
<a class="btn btn-gray" href="/user/reset">◌ Reset stats</a>
<a class="btn btn-gray" href="/dashboard">⟳ Actualiser</a>
</div></div></div>
<div class="card"><div class="ch">📋 JOURNAL — ${u.logs.length} entrées</div>
<div class="cb" style="padding:8px"><div class="log">${logHtml||'<div class="le in"><span class="lt">—</span><span>▸ En attente</span></div>'}</div>
</div></div>
</div></body></html>`;
}

function adminPage(err='', ok='') {
  const list = Object.values(users);
  const rows = list.map(u=>`<tr>
<td>${u.username}</td>
<td style="color:${u.botActive?'var(--g)':'var(--m)'}">${u.botActive?'● Actif':'■ Arrêté'}</td>
<td style="color:var(--g)">${u.stats.confirmed}</td>
<td style="color:var(--o)">${u.stats.missing}</td>
<td style="color:var(--r)">${u.stats.rejected}</td>
<td>${parseCookies(u.cfg.mgmtCookies).length>20?'<span class="tag-ok">✓</span>':'<span class="tag-err">✗</span>'}</td>
<td>${u.cfg.connectproToken?'<span class="tag-ok">✓</span>':'<span class="tag-err">✗</span>'}</td>
<td><form method="POST" action="/admin/delete-user" style="display:inline"><input type="hidden" name="userId" value="${u.id}"><button class="btn btn-red" style="font-size:10px;padding:3px 8px" onclick="return confirm('Supprimer ${u.username} ?')">Supprimer</button></form></td>
</tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H-CP Admin</title>
<style>${CSS}</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🛡 Administration — YapsonBot7-H-CP</div>
  <a href="/logout" class="btn btn-gray" style="font-size:10px">Déconnexion</a>
</div>
${err?`<div style="color:var(--r);font-size:11px">✘ ${err}</div>`:''}
${ok?`<div style="color:var(--g);font-size:11px">✔ ${ok}</div>`:''}
<div class="statbar">
<div class="sc"><div class="sv" style="color:var(--p)">${list.length}</div><div class="sl">Utilisateurs</div></div>
<div class="sc"><div class="sv" style="color:var(--g)">${list.filter(u=>u.botActive).length}</div><div class="sl">Actifs</div></div>
<div class="sc vc"><div class="sv">${list.reduce((s,u)=>s+u.stats.confirmed,0)}</div><div class="sl">Confirmés total</div></div>
<div class="sc vm"><div class="sv">${list.reduce((s,u)=>s+u.stats.missing,0)}</div><div class="sl">Manquants total</div></div>
</div>
<div class="card"><div class="ch">➕ CRÉER UN UTILISATEUR</div><div class="cb">
<form method="POST" action="/admin/create-user">
<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
<div class="frow" style="margin:0;flex:1"><label>Nom d'utilisateur</label><input type="text" name="username" required style="width:auto"></div>
<div class="frow" style="margin:0;flex:1"><label>Mot de passe</label><input type="password" name="password" required style="width:auto"></div>
<button class="btn btn-purple">Créer</button>
</div></form></div></div>
<div class="card"><div class="ch">👥 UTILISATEURS (${list.length})</div><div class="cb">
${list.length===0?'<div style="color:var(--m);font-size:11px">Aucun utilisateur.</div>':`
<table class="tbl"><tr><th>Utilisateur</th><th>Statut</th><th>Confirmés</th><th>Manquants</th><th>Rejetés</th><th>Cookies</th><th>CP Token</th><th>Action</th></tr>
${rows}</table>`}
</div></div>
<div class="card"><div class="ch">🔑 MOT DE PASSE ADMIN</div><div class="cb">
<form method="POST" action="/admin/change-password">
<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
<div class="frow" style="margin:0;flex:1"><label>Ancien</label><input type="password" name="oldPass" style="width:auto"></div>
<div class="frow" style="margin:0;flex:1"><label>Nouveau</label><input type="password" name="newPass" style="width:auto"></div>
<button class="btn btn-save">Changer</button>
</div></form></div></div>
</div></body></html>`;
}

// ── Routes ────────────────────────────────────────────────────
app.get('/login',  (req,res) => res.send(loginPage()));
app.post('/login', (req,res) => {
  const{username,password}=req.body;
  if(username===ADMIN_USER&&password===ADMIN_PASS){
    const tok=createSession('admin',true);
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=315360000`);
    return res.redirect('/admin');
  }
  const u=Object.values(users).find(u=>u.username===username&&u.passwordHash===hashPass(password));
  if(u){
    const tok=createSession(u.id,false);
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=315360000`);
    return res.redirect('/dashboard');
  }
  res.send(loginPage('Identifiants incorrects'));
});
app.get('/logout',(req,res)=>{res.setHeader('Set-Cookie','session=; HttpOnly; Path=/; Max-Age=0');res.redirect('/login');});
app.get('/',(req,res)=>{const s=getSession(req);if(!s)return res.redirect('/login');return s.isAdmin?res.redirect('/admin'):res.redirect('/dashboard');});

app.get('/dashboard',requireLogin,(req,res)=>{const u=users[req.session.userId];if(!u)return res.redirect('/login');res.send(userPage(u));});

app.post('/user/save-accounts',requireLogin,(req,res)=>{
  const u=users[req.session.userId];if(!u)return res.redirect('/login');
  const{connectproToken,mgmtCookies,yapsonToken,platWave,platOrange}=req.body;
  if(connectproToken&&!connectproToken.startsWith('●')){u.cfg.connectproToken=connectproToken.trim();ulog(u,'ok','🔑 Token ConnectPro mis à jour');}
  if(yapsonToken&&!yapsonToken.startsWith('●')){u.cfg.yapsonToken=yapsonToken.trim();ulog(u,'ok','🟢 Jeton yapson-transfer mis à jour');}
  if(!u.cfg.platforms)u.cfg.platforms={WAVE:'connectpro',ORANGE:'connectpro'};
  if(platWave==='connectpro'||platWave==='yapson'||platWave==='yapson_perso')u.cfg.platforms.WAVE=platWave;
  if(platOrange==='connectpro'||platOrange==='yapson')u.cfg.platforms.ORANGE=platOrange;
  ulog(u,'ok',`⚙ Plateformes — Wave: ${u.cfg.platforms.WAVE} · Orange: ${u.cfg.platforms.ORANGE}`);
  if(mgmtCookies){const t=mgmtCookies.trim();const ok=t.startsWith('[')||/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(t);const bad=t.includes('configuré')||t.includes('(coller')||t.startsWith('(');if(ok&&!bad){u.cfg.mgmtCookies=t;ulog(u,'ok',`🍪 Cookies mis à jour — ${parseCookies(t).split(';').length} cookie(s)`);}}
  ulog(u,'ok','Comptes sauvegardés');
  saveUser(u);
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.post('/user/save-config',requireLogin,(req,res)=>{
  const u=users[req.session.userId];if(!u)return res.redirect('/login');
  if(req.body.pollInterval)u.cfg.pollInterval=Math.max(60,parseInt(req.body.pollInterval));
  if(req.body.maxSolde!==undefined)u.cfg.maxSolde=parseInt(req.body.maxSolde)||0;
  ulog(u,'ok',`Config: intervalle=${u.cfg.pollInterval}s`);
  saveUser(u);
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.get('/user/start',requireLogin,(req,res)=>{const u=users[req.session.userId];if(u){startPolling(u);saveUser(u);}res.redirect('/dashboard');});
app.get('/user/stop', requireLogin,(req,res)=>{const u=users[req.session.userId];if(u){stopPolling(u);saveUser(u);} res.redirect('/dashboard');});
app.get('/user/run',  requireLogin,(req,res)=>{const u=users[req.session.userId];if(u)runCycle(u).catch(e=>ulog(u,'err',e.message));res.redirect('/dashboard');});
app.get('/user/reset',requireLogin,(req,res)=>{const u=users[req.session.userId];if(u){Object.keys(u.stats).forEach(k=>u.stats[k]=0);u.logs.length=0;if(u.blacklist)u.blacklist.clear();ulog(u,'info','Reset + blacklist vidée');}res.redirect('/dashboard');});

app.get('/admin',requireAdmin,(req,res)=>res.send(adminPage()));
app.post('/admin/create-user',requireAdmin,(req,res)=>{
  const{username,password}=req.body;
  if(!username||!password)return res.send(adminPage('Nom et mot de passe requis'));
  if(Object.values(users).find(u=>u.username===username.trim()))return res.send(adminPage(`"${username}" existe déjà`));
  createUser(username.trim(),password.trim());
  res.send(adminPage('',`"${username}" créé ✔`));
});
app.post('/admin/delete-user',requireAdmin,(req,res)=>{
  const u=users[req.body.userId];if(!u)return res.send(adminPage('Introuvable'));
  const name=u.username;stopPolling(u);if(u.loginBrowser)u.loginBrowser.close().catch(()=>{});delete users[req.body.userId];deleteUserFromDB(req.body.userId);
  res.send(adminPage('',`"${name}" supprimé ✔`));
});
app.post('/admin/change-password',requireAdmin,(req,res)=>{
  const{oldPass,newPass}=req.body;
  if(oldPass!==ADMIN_PASS)return res.send(adminPage('Ancien mot de passe incorrect'));
  if(!newPass||newPass.length<4)return res.send(adminPage('Mot de passe trop court'));
  ADMIN_PASS=newPass;
  saveAdminPass(newPass);
  res.send(adminPage('','Mot de passe admin changé ✔'));
});
app.get('/health',(req,res)=>{
  const s=getSession(req);if(!s)return res.status(401).json({error:'Non autorisé'});
  if(s.isAdmin)return res.json({users:Object.values(users).map(u=>({username:u.username,botActive:u.botActive,confirmed:u.stats.confirmed}))});
  const u=users[s.userId];return u?res.json({...u.stats,botActive:u.botActive}):res.status(404).json({error:'Introuvable'});
});

// ── NAVIGATEUR INTÉGRÉ (ajouté) ──────────────────────────────
// ── NAVIGATEUR INTÉGRÉ ────────────────────────────────────────
async function installPlaywright() {
try{require('child_process').execSync('npx playwright install chromium --with-deps',{stdio:'inherit',timeout:120000});}catch{}
}
async function ensureLoginBrowser(u) {
if (!u.loginBrowser||!u.loginBrowser.isConnected()) {
ulog(u,'info','🌐 Lancement navigateur login…');
try { u.loginBrowser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--window-size=390,844']}); }
catch(e) { if(e.message.includes('Executable')||e.message.includes("doesn't exist")){await installPlaywright();u.loginBrowser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--window-size=390,844']});}else throw e; }
}
if (!u.loginPage||u.loginPage.isClosed()) {
u.loginPage=await u.loginBrowser.newPage();
await u.loginPage.setViewportSize({width:390,height:844});
await u.loginPage.setExtraHTTPHeaders({'Accept-Language':'fr-FR,fr;q=0.9'});
}
}
async function captureLoginScreenshot(u) {
try {
if(!u.loginPage||u.loginPage.isClosed()) return null;
const buf=await u.loginPage.screenshot({type:'jpeg',quality:70,fullPage:false});
u.loginScreenshot=buf.toString('base64');
return u.loginScreenshot;
} catch{return null;}
}
async function startScreenshotLoop(u) {
while(u.loginBrowser&&u.loginBrowser.isConnected()&&u.loginPage&&!u.loginPage.isClosed()){
await captureLoginScreenshot(u);
await new Promise(r=>setTimeout(r,500));
}
}

app.post('/user/browser/open', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.redirect('/login');
try{await ensureLoginBrowser(u);await u.loginPage.goto(MGMT_URL,{waitUntil:'domcontentloaded',timeout:30000});ulog(u,'info','🌐 Navigateur login ouvert');startScreenshotLoop(u).catch(()=>{});res.redirect('/user/browser');}
catch(e){ulog(u,'err',`Navigateur login: ${e.message}`);res.redirect('/dashboard');}
});
app.post('/user/browser/close', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.redirect('/login');
try{if(u.loginBrowser){await u.loginBrowser.close();u.loginBrowser=null;u.loginPage=null;}ulog(u,'info','🌐 Navigateur login fermé');}catch{}
res.redirect('/dashboard');
});
app.post('/user/browser/click', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(400).json({error:'user not found'});
const{x,y}=req.body;
try{if(u.loginPage&&!u.loginPage.isClosed()){await u.loginPage.mouse.click(parseFloat(x),parseFloat(y));await new Promise(r=>setTimeout(r,300));await captureLoginScreenshot(u);}res.json({ok:true});}
catch(e){res.json({error:e.message});}
});
app.post('/user/browser/type', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(400).json({error:'user not found'});
const{text}=req.body;
try{if(u.loginPage&&!u.loginPage.isClosed()){await u.loginPage.keyboard.type(text,{delay:50});await new Promise(r=>setTimeout(r,200));await captureLoginScreenshot(u);}res.json({ok:true});}
catch(e){res.json({error:e.message});}
});
app.post('/user/browser/goto', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(400).json({error:'user not found'});
const{url}=req.body;
try{if(u.loginPage&&!u.loginPage.isClosed()){await u.loginPage.goto(url,{waitUntil:'domcontentloaded',timeout:20000});await new Promise(r=>setTimeout(r,500));await captureLoginScreenshot(u);}res.json({ok:true});}
catch(e){res.json({error:e.message});}
});
app.post('/user/browser/key', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(400).json({error:'user not found'});
const{key}=req.body;
try{if(u.loginPage&&!u.loginPage.isClosed()){await u.loginPage.keyboard.press(key);await new Promise(r=>setTimeout(r,300));await captureLoginScreenshot(u);}res.json({ok:true});}
catch(e){res.json({error:e.message});}
});
app.post('/user/browser/capture-cookies', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(400).json({error:'user not found'});
try{
if(!u.loginPage||u.loginPage.isClosed()) return res.json({error:'Navigateur fermé'});
const currentUrl=u.loginPage.url();
if(currentUrl.includes('login')||currentUrl.includes('signin')) return res.json({error:'Pas encore connecté — complète le login puis clique Capturer'});
const ctx=u.loginPage.context();
const cookies=await ctx.cookies();
const mgmtCookies=cookies.filter(c=>c.domain.includes('my-managment')||c.domain.includes('managment'));
if(mgmtCookies.length===0) return res.json({error:'Aucun cookie my-managment trouvé'});
const cookieStr=JSON.stringify(mgmtCookies);
u.cfg.mgmtCookies=cookieStr;
saveUser(u);
ulog(u,'ok',`🍪 ${mgmtCookies.length} cookie(s) capturés depuis navigateur intégré`);
res.json({ok:true,count:mgmtCookies.length});
}catch(e){res.json({error:e.message});}
});
app.get('/user/browser/screenshot', requireLogin, async(req,res)=>{
const u=users[req.session.userId]; if(!u) return res.status(404).end();
try{await captureLoginScreenshot(u);if(!u.loginScreenshot) return res.status(204).end();res.setHeader('Content-Type','image/jpeg');res.send(Buffer.from(u.loginScreenshot,'base64'));}
catch{res.status(500).end();}
});

app.get('/user/browser', requireLogin, (req,res)=>{
const u=users[req.session.userId]; if(!u) return res.redirect('/login');
const hasNav=u.loginBrowser&&u.loginBrowser.isConnected()&&u.loginPage&&!u.loginPage.isClosed();
res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<title>Navigateur — ${u.username}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#0f1117;color:#e2e8f0;font-family:monospace;display:flex;flex-direction:column;height:100vh;height:100dvh;overflow:hidden}
#topbar{background:#1e1e2e;padding:8px;padding-top:calc(8px + env(safe-area-inset-top,0));display:flex;gap:6px;align-items:center;flex-shrink:0;flex-wrap:wrap}
#urlbar{flex:1;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:5px 8px;font-size:13px}
.tbtn{border:none;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap}
.tbtn-green{background:#a6e3a1;color:#1e1e2e}.tbtn-blue{background:#89b4fa;color:#1e1e2e}
.tbtn-red{background:#f38ba8;color:#1e1e2e}.tbtn-orange{background:#fab387;color:#1e1e2e}
#screen-wrap{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000;cursor:crosshair}
#screen{max-width:100%;max-height:100%;display:block;touch-action:none}
#keyboard{background:#1e1e2e;padding:6px;padding-bottom:calc(6px + env(safe-area-inset-bottom,0));flex-shrink:0}
#textinput{width:100%;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px;font-size:14px;margin-bottom:5px}
.keyrow{display:flex;gap:4px;margin-bottom:4px;justify-content:center;flex-wrap:wrap}
#keyboard .keyrow .tbtn{padding:10px 12px;font-size:13px}
#capture-btn{background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:bold;cursor:pointer;width:100%;margin-top:4px}
#status-bar{background:#0a0e18;padding:4px 8px;font-size:10px;color:#6c7086;flex-shrink:0}
</style></head><body>
<div id="topbar">
  <a href="/dashboard" class="tbtn tbtn-red">← Retour</a>
  <input id="urlbar" type="text" value="${MGMT_URL}">
  <button class="tbtn tbtn-blue" onclick="gotoUrl()">Aller</button>
  ${hasNav?'':`<form method="POST" action="/user/browser/open" style="display:inline"><button class="tbtn tbtn-green" type="submit">▶ Ouvrir</button></form>`}
</div>
${hasNav?`
<div id="screen-wrap"><img id="screen" src="/user/browser/screenshot?t=${Date.now()}" alt="Navigateur"></div>
<div id="keyboard">
  <input id="textinput" type="text" placeholder="Tape ici puis appuie sur Envoyer…">
  <div class="keyrow">
    <button class="tbtn tbtn-blue" style="flex:2" onclick="sendText()">Envoyer texte</button>
    <button class="tbtn tbtn-orange" style="flex:2" onclick="sendKey('Enter')">Entrée ↵</button>
    <button class="tbtn tbtn-red" style="flex:1" onclick="sendKey('Backspace')">⌫</button>
    <button class="tbtn" style="background:#313244;color:#cdd6f4;flex:1" onclick="sendKey('Tab')">Tab</button>
  </div>
  <button id="capture-btn" onclick="captureCookies()">🍪 Je suis connecté — Capturer les cookies</button>
</div>
<div id="status-bar">Prêt — Clique sur l'écran pour interagir</div>
<script>
const screen=document.getElementById('screen'),statusBar=document.getElementById('status-bar'),textInput=document.getElementById('textinput'),urlbar=document.getElementById('urlbar');
let polling=true;
async function pollScreenshot(){while(polling){try{const r=await fetch('/user/browser/screenshot?t='+Date.now());if(r.ok){const blob=await r.blob();const url=URL.createObjectURL(blob);const old=screen.src;screen.src=url;if(old.startsWith('blob:'))URL.revokeObjectURL(old);}}catch{}await new Promise(r=>setTimeout(r,500));}}
pollScreenshot();
screen.addEventListener('click',async(e)=>{const rect=screen.getBoundingClientRect();const x=(e.clientX-rect.left)*390/rect.width;const y=(e.clientY-rect.top)*844/rect.height;statusBar.textContent='Clic à ('+Math.round(x)+', '+Math.round(y)+')…';await fetch('/user/browser/click',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x='+x+'&y='+y});statusBar.textContent='Clic effectué';});
screen.addEventListener('touchend',async(e)=>{e.preventDefault();const touch=e.changedTouches[0];const rect=screen.getBoundingClientRect();const x=(touch.clientX-rect.left)*390/rect.width;const y=(touch.clientY-rect.top)*844/rect.height;await fetch('/user/browser/click',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x='+x+'&y='+y});});
async function sendText(){const text=textInput.value;if(!text)return;await fetch('/user/browser/type',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'text='+encodeURIComponent(text)});textInput.value='';statusBar.textContent='Texte envoyé';}
async function sendKey(key){await fetch('/user/browser/key',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'key='+encodeURIComponent(key)});statusBar.textContent='Touche: '+key;}
async function gotoUrl(){statusBar.textContent='Navigation…';await fetch('/user/browser/goto',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'url='+encodeURIComponent(urlbar.value)});}
async function captureCookies(){statusBar.textContent='Capture des cookies…';document.getElementById('capture-btn').disabled=true;const r=await fetch('/user/browser/capture-cookies',{method:'POST'});const data=await r.json();if(data.ok){statusBar.textContent='✅ '+data.count+' cookies capturés ! Retour au dashboard…';document.getElementById('capture-btn').textContent='✅ Cookies capturés !';setTimeout(()=>{window.location='/dashboard';},2000);}else{statusBar.textContent='❌ '+(data.error||'Erreur');document.getElementById('capture-btn').disabled=false;}}
textInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendText();}});
</script>`:`
<div style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:20px;text-align:center">
  <div style="font-size:48px">🌐</div>
  <div style="color:#a6e3a1;font-size:16px">Navigateur intégré</div>
  <div style="color:#6c7086;font-size:12px;max-width:300px">Connecte-toi à my-managment.com manuellement, puis clique <strong>Capturer les cookies</strong>.</div>
  <form method="POST" action="/user/browser/open"><button type="submit" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:bold;cursor:pointer">▶ Ouvrir le navigateur</button></form>
</div>`}
</body></html>`);
});

app.listen(PORT, async ()=>{
  console.log(`YapsonBot7-H-CP (ConnectPro) — port ${PORT} | Admin: ${ADMIN_USER}`);
  await loadAdminPass();
  await loadUsersFromDB();
});
