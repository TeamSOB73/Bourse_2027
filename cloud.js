// cloud.js — couche Firebase pour la Bourse aux Skis (à charger APRÈS le script principal)
// <script type="module" src="cloud.js"></script>   (juste avant </body>)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, runTransaction, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ⚠️ À REMPLIR avec la config de votre projet Firebase (elle est publique par conception)
const firebaseConfig = {
  apiKey: 'VOTRE_API_KEY',
  authDomain: 'VOTRE_PROJET.firebaseapp.com',
  projectId: 'VOTRE_PROJET',
  appId: 'VOTRE_APP_ID'
};
const EMAIL_DOMAIN = 'bourse-bassens.example'; // comptes : poste1@..., ventes@..., caisses@...

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);
const toast = (m, t) => showToast(m, t);

// Les données personnelles ne doivent plus rester en clair dans le navigateur
try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
window.saveAppData = () => {};
window.loadAppData = () => {};

const fail = err => {
  console.error(err);
  toast(err.code === 'permission-denied' ? 'Action non autorisée.'
    : err.message === 'RANGE' ? 'Plage de numérotation atteinte.'
    : 'Erreur réseau ou serveur, réessayez.', 'error');
};

// ---------- Synchronisation temps réel ----------
let unsubs = [];
let busy = false;
function stopSync() { unsubs.forEach(u => u()); unsubs = []; }

function onData() {
  if (!busy) {
    const before = appState.cart.length;
    appState.cart = appState.cart.map(c => appState.articles.find(a => a.id === c.id)).filter(a => a && a.status === 'available');
    if (appState.cart.length < before) toast('Un article du panier a été vendu ailleurs.', 'warning');
  }
  const t = appState.activeTab;
  if (t === 'depots') { renderPosteDeposantsList(); renderVolunteerActiveDossier(); }
  if (t === 'ventes') { renderAvailableStock(); renderCart(); }
  if (t === 'caisses') renderCaissesDashboard();
  const el = $('autosave-time');
  if (el) el.textContent = 'Sync ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function startSync(role) {
  stopSync();
  const listen = (q, key, sorter) => unsubs.push(onSnapshot(q, snap => {
    appState[key] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    if (sorter) appState[key].sort(sorter);
    onData();
  }, fail));
  listen(query(collection(db, 'deposants'), orderBy('createdAt')), 'deposants');
  listen(collection(db, 'articles'), 'articles', (a, b) => Number(a.code) - Number(b.code));
  if (role === 'ventes' || role === 'caisses') listen(collection(db, 'sales'), 'sales');
}

// ---------- Connexion (remplace les hachages SHA-256 du code) ----------
const ROLE_TO_POSTE = { poste1: 'POSTE_1', poste2: 'POSTE_2', poste3: 'POSTE_3', poste4: 'POSTE_4', postepro: 'POSTE_PRO' };
const ROLE_OPTIONS = {
  depots: [['poste1', 'Poste 1'], ['poste2', 'Poste 2'], ['poste3', 'Poste 3'], ['poste4', 'Poste 4'], ['postepro', 'Poste Pro'], ['caisses', 'Responsable']],
  ventes: [['ventes', 'Ventes'], ['caisses', 'Responsable']],
  caisses: [['caisses', 'Responsable']]
};

const _openAccessModal = window.openAccessModal;
window.openAccessModal = target => {
  _openAccessModal(target);
  let sel = $('access-role-select');
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'access-role-select';
    sel.className = 'w-full px-3 py-2.5 mb-3 rounded-xl border-2 border-slate-300 bg-white text-sm font-bold';
    $('access-password-input').parentElement.insertAdjacentElement('beforebegin', sel);
  }
  sel.innerHTML = (ROLE_OPTIONS[target] || []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
};

window.submitAccessPassword = async e => {
  e.preventDefault();
  const pwd = $('access-password-input').value.trim();
  const role = $('access-role-select').value;
  const err = $('access-error-msg');
  if (!pwd) return;
  try {
    await setPersistence(auth, browserSessionPersistence);
    await signInWithEmailAndPassword(auth, `${role}@${EMAIL_DOMAIN}`, pwd);
  } catch (ex) {
    err.textContent = 'Mot de passe incorrect (ou trop de tentatives, réessayez plus tard).';
    err.classList.remove('hidden');
    return;
  }
  const target = appState.pendingAccessTarget;
  appState.unlockedDepotPoste = null; appState.isVentesUnlocked = false; appState.isCaissesUnlocked = false;
  if (role === 'caisses') {
    appState.isCaissesUnlocked = true; appState.isVentesUnlocked = true;
    appState.unlockedDepotPoste = DEPOT_POSTES_CONFIG.POSTE_1;
  } else if (role === 'ventes') appState.isVentesUnlocked = true;
  else appState.unlockedDepotPoste = DEPOT_POSTES_CONFIG[ROLE_TO_POSTE[role]];
  appState.selectedVolunteerDepId = null;
  closeAccessModal();
  startSync(role);
  toast('Accès autorisé', 'success');
  activateView(role === 'caisses' ? (target || 'caisses') : role === 'ventes' ? 'ventes' : 'depots');
};

const _lockAll = window.lockAllVolunteerSpaces;
window.lockAllVolunteerSpaces = () => {
  stopSync();
  appState.deposants = []; appState.articles = []; appState.sales = [];
  _lockAll();
  signOut(auth).catch(() => {});
};

// ---------- Numérotation atomique (aucun doublon entre appareils) ----------
// counters/{id}.n = dernier numéro attribué
async function reserve(tx, id, count, first, max = Infinity) {
  const ref = doc(db, 'counters', id);
  const snap = await tx.get(ref);
  const start = snap.exists() ? snap.data().n + 1 : first;
  if (start + count - 1 > max) throw new Error('RANGE');
  tx.set(ref, { n: start + count - 1 });
  return start;
}
const depCode = n => 'DEP' + String(n).padStart(2, '0');

// ---------- Dépôts ----------
window.handleCreateDeposantVolunteer = async e => {
  e.preventDefault();
  const poste = appState.unlockedDepotPoste; if (!poste) return;
  const form = e.target, v = id => $(id).value.trim();
  const id = 'DEP-ID-' + crypto.randomUUID();
  try {
    const depositNumber = await runTransaction(db, async tx => depCode(await reserve(tx, 'deposants', 1, 1)));
    await setDoc(doc(db, 'deposants', id), {
      depositNumber, postId: poste.id, nom: v('vol-dep-nom').toUpperCase(), prenom: v('vol-dep-prenom'),
      tel: v('vol-dep-tel'), email: v('vol-dep-email'), isPro: poste.isPro, restituted: false, createdAt: new Date().toISOString()
    });
    appState.selectedVolunteerDepId = id;
    form.reset();
    toast(`Dossier ${depositNumber} créé`, 'success');
  } catch (err) { fail(err); }
};

window.handleAddArticleVolunteer = async e => {
  e.preventDefault();
  const dep = appState.deposants.find(d => d.id === appState.selectedVolunteerDepId); if (!dep) return;
  const poste = appState.unlockedDepotPoste || getPosteConfigById(dep.postId);
  const form = e.target, v = id => $(id).value.trim();
  const price = parseFloat($('vol-art-price').value);
  if (!v('vol-art-brandmodel') || !v('vol-art-size') || isNaN(price) || price <= 0) return toast('Vérifiez les champs obligatoires.', 'error');
  try {
    const n = await runTransaction(db, tx => reserve(tx, 'art_' + poste.id, 1, poste.minArt, poste.maxArt));
    await setDoc(doc(db, 'articles', 'ART-' + crypto.randomUUID()), {
      deposantId: dep.id, code: String(n), type: $('vol-art-type').value, brandModel: v('vol-art-brandmodel'),
      size: v('vol-art-size'), price, notes: v('vol-art-notes'), status: 'available', soldAt: null, createdAt: new Date().toISOString()
    });
    form.reset();
    toast(`Article n° ${n} ajouté (${dep.depositNumber})`, 'success');
  } catch (err) { fail(err); }
};

window.deleteVolunteerArticle = artId => openConfirmModal('Supprimer ?', 'Supprimer cet article ? Son numéro ne sera pas réutilisé.',
  () => deleteDoc(doc(db, 'articles', artId)).then(() => toast('Article supprimé.', 'info')).catch(fail));

window.processProBulkImport = async () => {
  const poste = appState.unlockedDepotPoste; if (!poste || !poste.isPro) return;
  const shop = $('pro-shop-name').value.trim().toUpperCase(), tel = $('pro-shop-tel').value.trim();
  const rows = $('pro-bulk-textarea').value.split('\n').map(l => l.split(';').map(p => p.trim()))
    .filter(p => p.length >= 4 && parseFloat(p[3]) > 0);
  if (!shop || !tel || !rows.length) return toast('Renseignez le magasin et au moins un article valide (type;modèle;taille;prix).', 'error');
  if (rows.length > 400) return toast('Maximum 400 articles par import.', 'error');
  const depId = 'DEP-ID-' + crypto.randomUUID(), now = new Date().toISOString();
  try {
    const { dn, an } = await runTransaction(db, async tx => ({
      dn: await reserve(tx, 'deposants', 1, 1),
      an: await reserve(tx, 'art_' + poste.id, rows.length, poste.minArt)
    }));
    const batch = writeBatch(db);
    batch.set(doc(db, 'deposants', depId), { depositNumber: depCode(dn), postId: poste.id, nom: shop, prenom: 'PRO', tel, email: '', isPro: true, restituted: false, createdAt: now });
    rows.forEach((p, i) => batch.set(doc(db, 'articles', 'ART-' + crypto.randomUUID()), {
      deposantId: depId, code: String(an + i), type: p[0] || 'Skis', brandModel: p[1], size: p[2], price: parseFloat(p[3]),
      notes: 'Lot Pro', status: 'available', soldAt: null, createdAt: now
    }));
    await batch.commit();
    appState.selectedVolunteerDepId = depId;
    closeProImportModal();
    toast(`${rows.length} articles Pro importés (${depCode(dn)}).`, 'success');
  } catch (err) { fail(err); }
};

// ---------- Vente : transaction anti double-vente ----------
window.checkoutCart = async () => {
  if (!appState.cart.length) return toast('Panier vide.', 'warning');
  const ids = appState.cart.map(i => i.id), method = appState.paymentMethod;
  busy = true;
  try {
    const total = await runTransaction(db, async tx => {
      const refs = ids.map(id => doc(db, 'articles', id));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      const now = new Date().toISOString();
      let sum = 0;
      snaps.forEach(s => {
        if (!s.exists() || s.data().status !== 'available') throw new Error('SOLD:' + (s.exists() ? s.data().code : '?'));
        sum += Number(s.data().price); // prix lu côté serveur, pas depuis le panier
      });
      refs.forEach(r => tx.update(r, { status: 'sold', soldAt: now }));
      tx.set(doc(db, 'sales', 'VENTE-' + crypto.randomUUID()), { articleIds: ids, total: sum, paymentMethod: method, date: now, by: auth.currentUser.email });
      return sum;
    });
    appState.cart = [];
    toast(`Encaissement validé : ${total.toFixed(2)} €`, 'success');
  } catch (err) {
    if (String(err.message).startsWith('SOLD:')) toast(`Article n° ${err.message.slice(5)} déjà vendu : panier mis à jour.`, 'error');
    else fail(err);
  } finally { busy = false; onData(); }
};

// ---------- Caisses ----------
window.toggleRestitutedStatus = depId => {
  const dep = appState.deposants.find(d => d.id === depId); if (!dep) return;
  updateDoc(doc(db, 'deposants', depId), { restituted: !dep.restituted }).catch(fail);
};

// Export CSV protégé contre l'injection de formules et les ; dans les champs
const cell = x => { const s = String(x ?? '').replace(/[;\r\n]+/g, ' '); return /^[=+\-@\t]/.test(s) ? "'" + s : s; };
window.exportSpreadsheetCSV = () => {
  const rows = [['Club', 'N° Déposant', 'Nom', 'Prénom', 'N° Article', 'Type', 'Prix (€)', 'Statut'].join(';')];
  appState.articles.forEach(a => {
    const d = appState.deposants.find(x => x.id === a.deposantId) || {};
    rows.push([CLUB_NAME, d.depositNumber, d.nom, d.prenom, a.code, a.type, a.price, a.status].map(cell).join(';'));
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' }));
  link.download = `Bourse_Skis_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
};

// ---------- Fonctions désactivées / à compléter ----------
const off = () => toast('Désactivé : les données sont dans Firebase (voir la console pour une nouvelle bourse).', 'warning');
window.handleSessionBackupUpload = e => { e.target.value = ''; off(); };
window.promptNewBlankSession = off;

// ---------- Bilans à signer : 4 par feuille A4 ----------
const DEDUCT_DEPOSIT_FEE = false; // true = les frais de dépôt sont retenus sur la somme restituée
const SMALL_MAX = 12;             // au-delà, le déposant a une page A4 entière
const eur = n => n.toFixed(2).replace('.', ',') + ' €';
const BILAN_CSS = `<style>
.bil table{width:100%;border-collapse:collapse}
.bil td,.bil th{padding:.4mm 1mm;border-bottom:1px solid #e2e8f0;text-align:left}
.bil th{font-size:.85em;text-transform:uppercase;border-bottom:1px solid #000}
.bil tr{break-inside:avoid}
</style>`;

function bilanBlock(d, big) {
  const arts = appState.articles.filter(a => a.deposantId === d.id).sort((a, b) => Number(a.code) - Number(b.code));
  const gross = arts.filter(a => a.status === 'sold').reduce((s, a) => s + Number(a.price), 0);
  const commission = gross * SALES_COMMISSION_RATE;
  const fee = getDeposantDepositFee(d, arts.length);
  const net = gross - commission - (DEDUCT_DEPOSIT_FEE ? fee : 0);
  const nSold = arts.filter(a => a.status === 'sold').length;
  const fs = big ? 11 : 8;
  const line = (l, v) => `<div style="display:flex;justify-content:space-between"><span>${l}</span><span>${v}</span></div>`;
  const rows = arts.map(a => `<tr><td>${escapeHtml(a.code)}</td><td>${escapeHtml(a.type)} ${escapeHtml(a.brandModel)}</td><td>${escapeHtml(a.size)}</td>
    <td style="text-align:right">${eur(Number(a.price))}</td><td style="font-weight:700">${a.status === 'sold' ? 'Vendu' : 'Restitué'}</td></tr>`).join('');
  return `<div class="bil" style="box-sizing:border-box;border:1px dashed #94a3b8;padding:4mm;font-size:${fs}px;line-height:1.25;${big ? '' : 'overflow:hidden;'}">
    <div style="display:flex;justify-content:space-between;font-size:${fs - 1}px;color:#475569"><span>${escapeHtml(CLUB_NAME)} • Bourse aux skis</span><span>${new Date().toLocaleDateString('fr-FR')}</span></div>
    <div style="margin:1mm 0 2mm"><b style="font-size:${fs + 4}px">${escapeHtml(d.depositNumber)}</b>
      <b style="font-size:${fs + 2}px"> ${escapeHtml(d.nom)} ${escapeHtml(d.prenom)}</b>
      <div>${escapeHtml(d.tel)}${d.email ? ' • ' + escapeHtml(d.email) : ''}</div></div>
    <table><thead><tr><th>N°</th><th>Article</th><th>Taille</th><th style="text-align:right">Prix</th><th>Statut</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:2mm">
      ${line(`Articles : ${arts.length} déposés / ${nSold} vendus / ${arts.length - nSold} restitués`, '')}
      ${line('Total des ventes', eur(gross))}
      ${line(`Part du club (${Math.round(SALES_COMMISSION_RATE * 100)} %)`, '− ' + eur(commission))}
      ${d.isPro ? '' : line(`Frais de dépôt (${arts.length} × ${eur(DEPOSIT_FEE_PARTICULIER)})`, DEDUCT_DEPOSIT_FEE ? '− ' + eur(fee) : eur(fee) + ' (réglés au dépôt)')}
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:${fs + 3}px;border-top:1px solid #000;margin-top:1mm;padding-top:1mm"><span>Somme à restituer</span><span>${eur(net)}</span></div>
    </div>
    <div style="margin-top:3mm;display:flex;justify-content:space-between;gap:4mm">
      <div>Date : ____ / ____ / ______</div><div style="flex:1;text-align:right">Signature du déposant :<div style="height:9mm"></div></div>
    </div></div>`;
}

window.printAllBilansToSign = () => {
  const count = d => appState.articles.filter(a => a.deposantId === d.id).length;
  const deps = appState.deposants.filter(d => d.depositNumber)
    .sort((a, b) => String(a.depositNumber).localeCompare(String(b.depositNumber), 'fr', { numeric: true }));
  if (!deps.length) return toast('Aucun dossier à imprimer.', 'warning');
  const pages = [];
  const small = deps.filter(d => count(d) <= SMALL_MAX);
  for (let i = 0; i < small.length; i += 4) {
    pages.push(`<div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3mm;height:272mm">${small.slice(i, i + 4).map(d => bilanBlock(d, false)).join('')}</div>`);
  }
  deps.filter(d => count(d) > SMALL_MAX).forEach(d => pages.push(bilanBlock(d, true)));
  $('print-area').innerHTML = BILAN_CSS + pages.map((p, i) => `<div class="${i < pages.length - 1 ? 'page-break' : ''}">${p}</div>`).join('');
  setTimeout(() => window.print(), 150);
};
