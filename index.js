'use strict';
// ============================================================
// yapson-bot7-h — Multi-utilisateurs
// Sans capture, 1 retrait par cycle (10min entre chaque)
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const crypto   = require('crypto');

const app  = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Sessions ──────────────────────────────────────────────────
const sessions = {};
function createSession(userId, isAdmin) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, isAdmin, expires: Date.now() + 8*3600*1000 };
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

function createUser(username, password) {
  const id = crypto.randomBytes(8).toString('hex');
  users[id] = {
    id, username,
    passwordHash: hashPass(password),
    cfg: {
      mgmtCookies : '',
      yapsonToken : '',
      reportId    : process.env.REPORT_ID || '8231c3be3216307da83c067d263c09ec',
      pollInterval: parseInt(process.env.POLL_INTERVAL || '600'),
      maxSolde    : parseInt(process.env.MAX_SOLDE || '0'),
    },
    stats: { confirmed:0, missing:0, fixed:0, polls:0, rejected:0 },
    logs: [],
    pollTimer: null, isRunning: false, botActive: false,
  };
  return users[id];
}

function ulog(u, type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  u.logs.unshift({ ts, type, msg });
  if (u.logs.length > 500) u.logs.pop();
  console.log(`[${u.username}][${type.toUpperCase()}] ${ts} — ${msg}`);
}

// ── Mapping réseau ────────────────────────────────────────────
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
function yapH(u) {
  return { 'Content-Type':'application/json', 'Authorization': `Bearer ${u.cfg.yapsonToken}` };
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Lire tous les retraits ────────────────────────────────────
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
    const filesRequired = cd?.files_required || 0;
    const subagentName  = row.subagent || `Fournisseur_${sid}`;
    if (!pm || montant <= 0 || !cd || !sid) continue;
    if (!groups[sid]) groups[sid] = { subagent_id:sid, subagentName, netTitle, network:detectNetwork(netTitle), filesRequired, items:[] };
    groups[sid].items.push({ phone:pm[0], montant, confirmData:cd, netTitle });
  }
  return groups;
}

// ── Décaissement ──────────────────────────────────────────────
async function payout(u, item, network) {
  const uuid = NET_UUIDS[network] || NET_UUIDS['Orangeint'];
  const res  = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method:'POST', headers:yapH(u),
    body:JSON.stringify({ amount:item.montant, recipient_phone:item.phone, network:uuid }),
  });
  const body = await res.json().catch(()=>({}));
  ulog(u,'info',`  🔍 Payout [${res.status}]: ${JSON.stringify(body).substring(0,120)}`);
  if (res.status===200||res.status===201) {
    return { ok:true, uid:body.uid||body.id||body.reference||null, phone:item.phone, montant:item.montant };
  }
  return { ok:false, err:JSON.stringify(body).substring(0,100) };
}

// ── Confirmation sans fichier ─────────────────────────────────
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
async function runCycle(u) {
  if (u.isRunning) return;
  u.isRunning = true; u.stats.polls++;
  ulog(u,'info',`━━ Poll #${u.stats.polls} ━━`);
  try {
    if (!parseCookies(u.cfg.mgmtCookies)) throw new Error('Cookies manquants');
    if (!u.cfg.yapsonToken) throw new Error('Token yapson manquant');

    const groups = await getAllWithdrawals(u);
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

        const payResult = await payout(u, item, network);
        if (!payResult.ok) {
          u.stats.missing++;
          ulog(u,'err',`  ✘ Décaissement échoué: ${item.phone} — ${payResult.err}`);
          processed = true; break;
        }
        ulog(u,'ok',`  ✔ Décaissé: ${item.phone} → ${item.montant.toLocaleString()} FCFA`);

        await sleep(2000);
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
`;

// ── Pages HTML ────────────────────────────────────────────────
function loginPage(err='') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H</title>
<style>${CSS}.box{max-width:380px;margin:80px auto;background:var(--s1);border:1px solid var(--s3);border-radius:12px;padding:28px}
h1{color:var(--p);font-size:1.2rem;margin-bottom:20px;text-align:center}</style></head>
<body><div class="box"><h1>🤖 YapsonBot7-H</h1>
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H — ${u.username}</title>
<style>${CSS}</style>
<script>if(${JSON.stringify(u.botActive)}) setTimeout(()=>location.reload(),15000);</script>
</head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🤖 ${u.username} <span style="font-size:10px;color:var(--m)">Bot7-H — 1 retrait/cycle</span></div>
  <a href="/logout" class="btn btn-gray" style="font-size:10px">Déconnexion</a>
</div>
<div class="statbar">
<div class="sc vc"><div class="sv">${u.stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${u.stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vp"><div class="sv">${u.stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vr"><div class="sv">${u.stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>
<div class="card"><div class="ch">🔑 COMPTES</div><div class="cb">
<form method="POST" action="/user/save-accounts"><div class="g2">
<div><div class="seclbl" style="color:var(--b)">agg.yapson.net</div>
<div class="frow"><label>Token Yapson</label>
<input type="password" name="yapsonToken" value="${u.cfg.yapsonToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${u.cfg.yapsonToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
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
<td>${u.cfg.yapsonToken?'<span class="tag-ok">✓</span>':'<span class="tag-err">✗</span>'}</td>
<td><form method="POST" action="/admin/delete-user" style="display:inline"><input type="hidden" name="userId" value="${u.id}"><button class="btn btn-red" style="font-size:10px;padding:3px 8px" onclick="return confirm('Supprimer ${u.username} ?')">Supprimer</button></form></td>
</tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-H Admin</title>
<style>${CSS}</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🛡 Administration — YapsonBot7-H</div>
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
<table class="tbl"><tr><th>Utilisateur</th><th>Statut</th><th>Confirmés</th><th>Manquants</th><th>Rejetés</th><th>Cookies</th><th>Token</th><th>Action</th></tr>
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
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=28800`);
    return res.redirect('/admin');
  }
  const u=Object.values(users).find(u=>u.username===username&&u.passwordHash===hashPass(password));
  if(u){
    const tok=createSession(u.id,false);
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=28800`);
    return res.redirect('/dashboard');
  }
  res.send(loginPage('Identifiants incorrects'));
});
app.get('/logout',(req,res)=>{res.setHeader('Set-Cookie','session=; HttpOnly; Path=/; Max-Age=0');res.redirect('/login');});
app.get('/',(req,res)=>{const s=getSession(req);if(!s)return res.redirect('/login');return s.isAdmin?res.redirect('/admin'):res.redirect('/dashboard');});

// Routes utilisateur
app.get('/dashboard',requireLogin,(req,res)=>{const u=users[req.session.userId];if(!u)return res.redirect('/login');res.send(userPage(u));});
app.post('/user/save-accounts',requireLogin,(req,res)=>{
  const u=users[req.session.userId];if(!u)return res.redirect('/login');
  const{yapsonToken,mgmtCookies}=req.body;
  if(yapsonToken&&!yapsonToken.startsWith('●')){u.cfg.yapsonToken=yapsonToken.trim();ulog(u,'ok','🔑 Token mis à jour');}
  if(mgmtCookies){const t=mgmtCookies.trim();const ok=t.startsWith('[')||/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(t);const bad=t.includes('configuré')||t.includes('(coller')||t.startsWith('(');if(ok&&!bad){u.cfg.mgmtCookies=t;ulog(u,'ok',`🍪 Cookies mis à jour — ${parseCookies(t).split(';').length} cookie(s)`);}}
  ulog(u,'ok','Comptes sauvegardés');
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.post('/user/save-config',requireLogin,(req,res)=>{
  const u=users[req.session.userId];if(!u)return res.redirect('/login');
  if(req.body.pollInterval)u.cfg.pollInterval=Math.max(60,parseInt(req.body.pollInterval));
  if(req.body.maxSolde!==undefined)u.cfg.maxSolde=parseInt(req.body.maxSolde)||0;
  ulog(u,'ok',`Config: intervalle=${u.cfg.pollInterval}s`);
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.get('/user/start',requireLogin,(req,res)=>{const u=users[req.session.userId];if(u)startPolling(u);res.redirect('/dashboard');});
app.get('/user/stop', requireLogin,(req,res)=>{const u=users[req.session.userId];if(u)stopPolling(u); res.redirect('/dashboard');});
app.get('/user/run',  requireLogin,(req,res)=>{const u=users[req.session.userId];if(u)runCycle(u).catch(e=>ulog(u,'err',e.message));res.redirect('/dashboard');});
app.get('/user/reset',requireLogin,(req,res)=>{const u=users[req.session.userId];if(u){Object.keys(u.stats).forEach(k=>u.stats[k]=0);u.logs.length=0;ulog(u,'info','Reset');}res.redirect('/dashboard');});

// Routes admin
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
  const name=u.username;stopPolling(u);delete users[req.body.userId];
  res.send(adminPage('',`"${name}" supprimé ✔`));
});
app.post('/admin/change-password',requireAdmin,(req,res)=>{
  const{oldPass,newPass}=req.body;
  if(oldPass!==ADMIN_PASS)return res.send(adminPage('Ancien mot de passe incorrect'));
  if(!newPass||newPass.length<4)return res.send(adminPage('Mot de passe trop court'));
  ADMIN_PASS=newPass;
  res.send(adminPage('','Mot de passe admin changé ✔'));
});
app.get('/health',(req,res)=>{
  const s=getSession(req);if(!s)return res.status(401).json({error:'Non autorisé'});
  if(s.isAdmin)return res.json({users:Object.values(users).map(u=>({username:u.username,botActive:u.botActive,confirmed:u.stats.confirmed}))});
  const u=users[s.userId];return u?res.json({...u.stats,botActive:u.botActive}):res.status(404).json({error:'Introuvable'});
});

app.listen(PORT,()=>console.log(`YapsonBot7-H multi-users — port ${PORT} | Admin: ${ADMIN_USER}`));
