/* Back2You — frontend logic (single file). Sections: api · state · ui · admin dialogs · detail popup · board · report · history · console · auth · boot */
(() => {
'use strict';

// ===== API =====
// All server calls go through here. Cookies (httpOnly JWT) are sent automatically.
async function request(method, url, body) {
  if (location.protocol === 'file:') {
    throw new Error('Open this site through the server: run "npm start", then visit http://localhost:3000 (do not open index.html directly).');
  }
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Cannot reach the server. Make sure "npm start" is running and MongoDB is connected.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/login')) document.dispatchEvent(new Event('b2y:unauthorized'));
    const err = new Error((data && data.message) || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  get: url => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body = {}) => request('PATCH', url, body)
};

async function download(url, filename) {
  const res = await fetch('/api' + url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Export failed.');
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

// ===== STATE =====
const state = {
  user: null,        // { id, name, email, idNo, department, role }
  items: [],         // verified + returned reports (public board)
  mine: [],          // my own submissions, any status
  history: [],
  type: 'all'        // active board tab
};
const isManager = () => state.user && state.user.role === 'management';

// ===== UI =====
const $ = id => document.getElementById(id);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
}

function openDialog(id) {
  const d = $(id);
  if (d.open) return;
  d.showModal ? d.showModal() : d.setAttribute('open', '');
}
function closeDialog(id) {
  const d = $(id);
  if (!d.open) return;
  d.close ? d.close() : d.removeAttribute('open');
}
function bindDialogs() {
  qsa('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
  qsa('dialog.modal').forEach(d => d.addEventListener('click', e => { if (e.target === d) closeDialog(d.id); }));
}

const EMOJI = { 'Electronics': '🎧', 'ID & Cards': '🪪', 'Bags': '🎒', 'Books & Notes': '📓', 'Accessories': '🔑', 'Clothing': '🧥', 'Other': '📦' };
const emojiFor = c => EMOJI[c] || '📦';

const STATUS_LABEL = { pending: 'Pending verification', verified: 'Verified', rejected: 'Rejected', returned: 'Handed over' };

function formatDate(s) {
  if (!s) return 'Date not provided';
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeAgo(s) {
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return formatDate(s);
  const days = Math.round((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return formatDate(s);
}
function formatStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function localToday() {
  const t = new Date();
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function setCount(el, target) {
  const from = Number(el.textContent) || 0;
  if (from === target) { el.textContent = target; return; }
  const start = performance.now();
  (function step(now) {
    const p = Math.min((now - start) / 600, 1);
    el.textContent = Math.round(from + (target - from) * p);
    if (p < 1) requestAnimationFrame(step);
  })(start);
}

const photoUrl = id => `/api/reports/${encodeURIComponent(id)}/photo`;
const thumb = i => `<span class="item-emoji">${esc(emojiFor(i.category))}</span>` +
  (i.hasPhoto ? `<img loading="lazy" src="${photoUrl(i.id)}" alt="${esc(i.name)}">` : '');

const refresh = (reopen) => document.dispatchEvent(new CustomEvent('b2y:refresh', { detail: { reopen } }));

// ===== ADMIN-DIALOGS =====
// Handover + reject dialogs. Used by both the detail popup and the management console.


let handoverCtx = null;
let rejectCtx = null;

// report: { id, name, type, location? }   claim: optional admin claim to pre-fill the receiver
function openHandover(report, claim = null) {
  handoverCtx = { id: report.id };
  $('handoverForm').reset();
  $('handoverError').hidden = true;
  $('handoverSummary').innerHTML = `<strong>${esc(report.name)}</strong> · ${esc(report.type)}${report.location ? ' · ' + esc(report.location) : ''}`;
  if (claim) {
    $('receiverName').value = claim.by.name;
    $('receiverIdNo').value = claim.by.idNo;
  }
  openDialog('handoverDialog');
}

// ctx: { kind: 'report' | 'claim', id, label, reopen? }
function openReject(ctx) {
  rejectCtx = ctx;
  $('rejectForm').reset();
  $('rejectError').hidden = true;
  $('rejectTitle').textContent = ctx.kind === 'claim' ? 'Reject claim' : 'Reject report';
  $('rejectSummary').innerHTML = `<strong>${esc(ctx.label)}</strong>`;
  openDialog('rejectDialog');
}

function initAdminDialogs() {
  $('handoverForm').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('handoverError');
    box.hidden = true;
    try {
      await api.post(`/admin/reports/${handoverCtx.id}/handover`, {
        receiverName: $('receiverName').value,
        receiverIdNo: $('receiverIdNo').value,
        note: $('handoverNote').value
      });
      closeDialog('handoverDialog');
      toast('Handover recorded.');
      refresh(handoverCtx.id);
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    }
  });

  $('rejectForm').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('rejectError');
    box.hidden = true;
    const path = rejectCtx.kind === 'claim' ? `/admin/claims/${rejectCtx.id}/reject` : `/admin/reports/${rejectCtx.id}/reject`;
    try {
      await api.patch(path, { note: $('rejectReason').value });
      closeDialog('rejectDialog');
      toast(rejectCtx.kind === 'claim' ? 'Claim rejected.' : 'Report rejected.');
      refresh(rejectCtx.reopen);
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

// ===== DETAIL =====
let current = null;

const box = (cls, html) => `<div class="claim-box ${cls}">${html}</div>`;

function submitterBlock(i) {
  const r = i.reporter;
  return `<div class="summary-box submitter"><small>Submitted by (visible to management only)</small>
    <strong>${esc(r.name)}</strong> · ${esc(r.role)}<br>${esc(r.idNo || '—')} · ${esc(r.department || '—')} · ${esc(r.email)}</div>`;
}

function managementActions(i) {
  let html = submitterBlock(i);

  if (i.status === 'pending') {
    return html + `<div class="mgmt-panel"><strong>Verification</strong>
      <p>Check the report is genuine before it goes on the board.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-act="approve">✓ Approve &amp; publish</button>
        <button class="btn btn-danger" type="button" data-act="reject">Reject</button>
      </div></div>`;
  }
  if (i.status === 'rejected') {
    return html + box('rejected', `Rejected${i.review && i.review.by ? ' by ' + esc(i.review.by.name) : ''}. Reason: ${esc((i.review && i.review.note) || '—')}`);
  }
  if (i.status === 'returned') {
    const h = i.handover || {};
    return html + `<div class="handover-record"><strong>✓ Handed over on ${esc(formatDate(String(h.at || '').slice(0, 10)))}</strong>
      Received by ${esc(h.receiverName)} (${esc(h.receiverIdNo)}).<br>Recorded by ${esc((h.by && h.by.name) || 'management')}.
      ${h.note ? '<br>Note: ' + esc(h.note) : ''}</div>
      <p class="link-row"><button class="link-btn" type="button" data-act="undo">Undo handover (marked by mistake)</button></p>`;
  }
  // verified
  const rows = (i.claims || []).filter(c => c.status === 'pending').map(c => `
    <div class="claim-row">
      <b>${esc(c.by.name)}</b>
      <small>${esc(c.by.idNo)} · ${esc(c.by.department)} · ${esc(formatDate(String(c.createdAt).slice(0, 10)))}</small>
      <q>${esc(c.note)}</q>
      <div class="btn-row">
        <button class="btn btn-outline btn-small" type="button" data-act="handover" data-claim="${esc(c.id)}">Verify &amp; hand over</button>
        <button class="btn btn-ghost btn-small" type="button" data-act="reject-claim" data-claim="${esc(c.id)}">Reject claim</button>
      </div>
    </div>`).join('');
  return html + `<div class="mgmt-panel"><strong>Management actions</strong>
    <p>Mark an item as handed over only after the owner has physically received it.</p>
    ${rows || '<p>No claims yet. You can still record a walk-in handover.</p>'}
    <button class="btn btn-primary btn-block" type="button" data-act="handover">✓ Mark as handed over</button></div>`;
}

function memberActions(i) {
  if (i.mine) {
    const m = {
      pending: ['waiting', 'Your report is waiting for management to verify it. It will appear on the board once approved.'],
      verified: ['waiting', 'Your report is live. Management will mark it handed over once the owner has received it.'],
      rejected: ['rejected', `Management could not verify this report.${i.reviewNote ? ' Reason: ' + esc(i.reviewNote) : ''}`],
      returned: ['done', '✓ This item has been handed over.']
    }[i.status];
    return box(m[0], m[1]);
  }
  if (i.status === 'returned') return box('done', '✓ This item was handed over to its owner.');
  if (i.myClaim) {
    const t = i.type === 'Found' ? 'claim' : 'response';
    const msg = {
      pending: `✓ Your ${t} was sent. Management will verify it. Please visit the management office.`,
      approved: `✓ Your ${t} was approved. Please collect it from the management office.`,
      closed: `Your ${t} was closed because the item went to another person.`,
      rejected: `Management could not approve your ${t}.`
    }[i.myClaim];
    return box(i.myClaim === 'rejected' || i.myClaim === 'closed' ? 'rejected' : 'done', msg);
  }
  const found = i.type === 'Found';
  return `<div class="claim-box"><strong>${found ? 'Is this yours?' : 'Did you find this?'}</strong>
    <p>${found ? 'Describe one detail only the owner would know (a sticker, contents, scratches).' : 'Tell management where and when you found it.'}</p>
    <textarea id="claimNote" rows="2" maxlength="200" placeholder="Write your verification note..."></textarea>
    <button class="btn btn-primary btn-block" type="button" data-act="send-claim">${found ? 'Send claim to management' : 'Send message to management'} →</button></div>`;
}

function render(i, manager) {
  $('detailContent').innerHTML = `
    <div class="detail-hero">${thumb(i)}</div>
    <div class="badge-row">
      <span class="item-status ${i.type === 'Lost' ? 'lost' : ''}">${esc(i.type)} item</span>
      <span class="state-badge ${esc(i.status)}">${esc(STATUS_LABEL[i.status])}</span>
    </div>
    <h2>${esc(i.name)}</h2>
    <p class="detail-description">${esc(i.description)}</p>
    <div class="detail-info">
      <div><small>Category</small><strong>${esc(i.category)}</strong></div>
      <div><small>Location</small><strong>${esc(i.location)}</strong></div>
      <div><small>Date</small><strong>${esc(formatDate(i.date))}</strong></div>
      <div><small>Posted by</small><strong>${esc(manager ? i.reporter.role : (i.postedBy || 'You'))}</strong></div>
    </div>
    <p class="detail-description">Items are handed over only by SRET management after the owner is verified. Contact details are never shared.</p>
    ${manager ? managementActions(i) : memberActions(i)}
    <button class="btn btn-secondary btn-block" type="button" data-act="close">Close</button>`;
}

async function openDetail(id, source = 'public') {
  const manager = isManager();
  try {
    current = manager
      ? await api.get(`/admin/reports/${encodeURIComponent(id)}`)
      : (source === 'mine' ? state.mine : state.items).find(i => i.id === id) || state.items.find(i => i.id === id);
  } catch (err) { return toast(err.message); }
  if (!current) return;
  render(current, manager);
  openDialog('detailDialog');
}

async function onAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !current) return;
  const act = btn.dataset.act;
  const id = current.id;
  const claim = (current.claims || []).find(c => c.id === btn.dataset.claim) || null;

  try {
    if (act === 'close') return closeDialog('detailDialog');

    if (act === 'send-claim') {
      const note = $('claimNote').value.trim();
      if (note.length < 8) return toast('Please add a little more detail (8+ characters).');
      await api.post('/claims', { reportId: id, note });
      toast('Sent to management. Visit the office to complete the handover.');
      return refresh(id);
    }
    if (!isManager()) return;

    if (act === 'approve') { await api.patch(`/admin/reports/${id}/verify`); toast('Report approved and published.'); return refresh(id); }
    if (act === 'reject') return openReject({ kind: 'report', id, label: current.name, reopen: id });
    if (act === 'reject-claim' && claim) return openReject({ kind: 'claim', id: claim.id, label: `${claim.by.name} → ${current.name}`, reopen: id });
    if (act === 'handover') return openHandover(current, claim);
    if (act === 'undo') {
      if (!confirm('Undo this handover? Use this only if it was marked by mistake. The undo is saved in history.')) return;
      await api.post(`/admin/reports/${id}/undo-handover`);
      toast('Handover undone.');
      refresh(id);
    }
  } catch (err) { toast(err.message); }
}

function initDetail() {
  $('detailContent').addEventListener('click', onAction);
}

// ===== BOARD =====
async function loadBoard() {
  const [items, mine] = await Promise.all([
    api.get('/reports/public'),
    isManager() ? [] : api.get('/reports/mine')
  ]);
  state.items = items;
  state.mine = mine;
  renderBoard();
}

function setType(type) {
  state.type = type;
  qsa('.filter-tab').forEach(b => {
    const on = b.dataset.type === type;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderBoard();
}

function filtered() {
  const q = $('searchInput').value.trim().toLowerCase();
  const cat = $('categoryFilter').value;
  const sort = $('sortSelect').value;
  const source = state.type === 'mine' ? state.mine : state.items;

  return source.filter(i => {
    const typeOk = state.type === 'all' || state.type === 'mine' || i.type === state.type;
    const catOk = cat === 'all' || i.category === cat;
    const hay = [i.name, i.description, i.location, i.category, i.type].join(' ').toLowerCase();
    return typeOk && catOk && hay.includes(q);
  }).sort((a, b) => sort === 'az'
    ? a.name.localeCompare(b.name)
    : (sort === 'old' ? -1 : 1) * String(b.date).localeCompare(String(a.date)));
}

function card(i) {
  const badge = i.status === 'returned'
    ? '<span class="returned-badge">✓ Handed over</span>'
    : (state.type === 'mine' ? `<span class="state-badge ${i.status}">${STATUS_LABEL[i.status]}</span>` : '');
  return `
    <article class="item-card ${i.status === 'returned' ? 'is-returned' : ''}" data-id="${esc(i.id)}"
             tabindex="0" role="button" aria-label="View details for ${esc(i.name)}">
      <div class="item-card-image">
        ${thumb(i)}
        <span class="item-status ${i.type === 'Lost' ? 'lost' : ''}">${esc(i.type)}</span>
        ${badge}
        <span class="item-category">${esc(i.category)}</span>
      </div>
      <div class="item-card-content">
        <h3>${esc(i.name)}</h3>
        <p class="item-description">${esc(i.description)}</p>
        <div class="item-meta"><span>⌖ ${esc(i.location)}</span><span>${esc(timeAgo(i.date))}</span></div>
        <div class="item-card-bottom">
          <span class="item-reporter">Posted by ${esc(i.postedBy || 'you')}</span>
          <span class="view-details">Details ↗</span>
        </div>
      </div>
    </article>`;
}

function stats() {
  const live = state.items.filter(i => i.status === 'verified');
  setCount($('lostCount'), live.filter(i => i.type === 'Lost').length);
  setCount($('foundCount'), live.filter(i => i.type === 'Found').length);
  setCount($('returnedCount'), state.items.filter(i => i.status === 'returned').length);
  $('allTabCount').textContent = state.items.length;
}

function hotspots() {
  const counts = {};
  state.items.forEach(i => { counts[i.location] = (counts[i.location] || 0) + 1; });
  const q = $('searchInput').value.trim().toLowerCase();
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('hotspotRow').innerHTML = top.length
    ? '<span class="hotspot-label">⌖ Hotspots</span>' + top.map(([loc, n]) =>
        `<button type="button" class="hotspot ${q === loc.toLowerCase() ? 'active' : ''}" data-loc="${esc(loc)}">${esc(loc)} <b>${n}</b></button>`).join('')
    : '';
}

function renderBoard() {
  const items = filtered();
  $('itemsGrid').innerHTML = items.map(card).join('');
  $('emptyState').hidden = items.length > 0;
  $('itemsGrid').hidden = items.length === 0;
  $('resultsText').textContent = `Showing ${items.length} ${items.length === 1 ? 'report' : 'reports'}`;
  stats();
  hotspots();
}

function initBoard() {
  $('searchInput').addEventListener('input', renderBoard);
  $('categoryFilter').addEventListener('change', renderBoard);
  $('sortSelect').addEventListener('change', renderBoard);

  qsa('.filter-tab').forEach(t => t.addEventListener('click', () => setType(t.dataset.type)));

  $('clearFiltersBtn').addEventListener('click', () => {
    $('searchInput').value = '';
    $('categoryFilter').value = 'all';
    $('sortSelect').value = 'new';
    setType('all');
  });

  $('hotspotRow').addEventListener('click', e => {
    const b = e.target.closest('.hotspot');
    if (!b) return;
    const same = $('searchInput').value.toLowerCase() === b.dataset.loc.toLowerCase();
    $('searchInput').value = same ? '' : b.dataset.loc;
    renderBoard();
  });

  $('itemsGrid').addEventListener('click', e => {
    const c = e.target.closest('.item-card');
    if (c) openDetail(c.dataset.id, state.type === 'mine' ? 'mine' : 'public');
  });
  $('itemsGrid').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = e.target.closest('.item-card');
    if (c) { e.preventDefault(); openDetail(c.dataset.id, state.type === 'mine' ? 'mine' : 'public'); }
  });
}

// ===== REPORT =====
const readDataUrl = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = reject;
  r.readAsDataURL(file);
});

function openReport() {
  $('reportForm').reset();
  $('itemDate').value = $('itemDate').max = localToday();
  $('reportNote').textContent = isManager()
    ? 'Posts from management go live on the board immediately.'
    : '🛡 Management will verify this report before it appears on the board. You can track its status under “My reports”.';
  $('mobileNav').hidden = true;
  openDialog('reportDialog');
}

async function submit(e) {
  e.preventDefault();
  const btn = $('reportSubmit');
  const file = $('itemPhoto').files[0];
  let photo = '';

  if (file) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return toast('Photo must be a JPG, PNG, WEBP or GIF.');
    if (file.size > 1024 * 1024) return toast('Please choose a photo smaller than 1 MB.');
    try { photo = await readDataUrl(file); } catch { return toast('Could not read that photo.'); }
  }

  btn.disabled = true;
  try {
    await api.post('/reports', {
      type: $('reportType').value, category: $('reportCategory').value,
      name: $('itemName').value, description: $('itemDescription').value,
      location: $('itemLocation').value, date: $('itemDate').value, photo
    });
    closeDialog('reportDialog');
    toast(isManager() ? 'Published to the board.' : 'Submitted! Management will verify your report.');
    setType(isManager() ? 'all' : 'mine');
    refresh();
    $('browse').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function initReport() {
  qsa('[data-open-report]').forEach(b => b.addEventListener('click', openReport));
  $('reportForm').addEventListener('submit', submit);
}

// ===== HISTORY =====
const META = {
  REPORT_CREATED:    { icon: '📝', title: e => `${e.itemType || 'Item'} report submitted` },
  REPORT_VERIFIED:   { icon: '✅', title: () => 'Report verified' },
  REPORT_REJECTED:   { icon: '⛔', title: () => 'Report rejected' },
  CLAIM_SENT:        { icon: '✋', title: e => e.itemType === 'Found' ? 'Claim request sent' : 'Response sent' },
  CLAIM_REJECTED:    { icon: '🚫', title: () => 'Claim rejected' },
  ITEM_HANDED_OVER:  { icon: '🤝', title: () => 'Item handed over' },
  HANDOVER_REVERSED: { icon: '↩️', title: () => 'Handover reversed' }
};

function detail(e, manager) {
  const d = e.details || {};
  const a = e.actor || {};
  const who = `${a.name || ''}${a.idNo ? ' (' + a.idNo + ')' : ''}`;
  switch (e.action) {
    case 'REPORT_CREATED':
      return `${e.itemName} · ${d.location || ''}${manager ? ' · by ' + who : ''}`;
    case 'REPORT_VERIFIED':
      return manager ? `${e.itemName} · approved by ${who}` : `${e.itemName} · approved by SRET management, now on the board`;
    case 'REPORT_REJECTED':
      return `${e.itemName} · ${d.note ? 'reason: ' + d.note : 'rejected by management'}`;
    case 'CLAIM_SENT':
      return `${e.itemName}${manager ? ' · by ' + who : ''} · “${d.note || ''}”`;
    case 'CLAIM_REJECTED':
      return manager ? `${e.itemName} · ${d.claimant || ''} · ${d.note || ''}` : `${e.itemName} · claim was not approved by management`;
    default:
      return manager
        ? `${e.itemName} → ${d.receiverName || ''} (${d.receiverIdNo || ''}) · by ${a.name || 'management'}${d.note ? ' · ' + d.note : ''}`
        : `${e.itemName} · ${e.action === 'ITEM_HANDED_OVER' ? 'handed over by SRET management' : 'handover was reversed by management'}`;
  }
}

async function loadHistory() {
  state.history = await api.get('/history');
  renderHistory();
}

function renderHistory() {
  const manager = isManager();
  const q = $('historySearch').value.trim().toLowerCase();
  const f = $('historyFilter').value;

  const rows = state.history.filter(e => {
    if (f !== 'all' && e.action !== f) return false;
    if (!q) return true;
    const d = e.details || {};
    return [e.itemName, e.itemType, e.action, e.actor && e.actor.name, e.actor && e.actor.idNo, d.receiverName, d.receiverIdNo]
      .join(' ').toLowerCase().includes(q);
  });

  $('historyList').innerHTML = rows.slice(0, 200).map(e => {
    const m = META[e.action] || { icon: '•', title: () => e.action };
    return `<li class="history-entry" data-action="${esc(e.action)}">
      <span class="history-icon">${m.icon}</span>
      <div class="history-main"><strong>${esc(m.title(e))}</strong><span>${esc(detail(e, manager))}</span></div>
      <time class="history-time" datetime="${esc(e.timestamp)}">${esc(formatStamp(e.timestamp))}</time>
    </li>`;
  }).join('');

  const empty = $('historyEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = state.history.length
    ? 'Nothing matches that search.'
    : (manager ? 'No activity yet.' : 'No activity yet. Submit a report or send a claim and it will appear here.');
}

function initHistory() {
  $('historySearch').addEventListener('input', renderHistory);
  $('historyFilter').addEventListener('change', renderHistory);
}

// ===== CONSOLE =====
// Management console: verification queue, claims, all records, uncollected found items, weekly/monthly reports, export.




const S = { reviews: [], claims: [], records: [], uncollected: [], period: 'week', offset: 0, summary: null };

const reporterLine = r => `${esc(r.name)} · ${esc(r.role)} · ${esc(r.idNo || '—')} · ${esc(r.department || '—')} · ${esc(r.email)}`;

function reviewCard(r) {
  return `<article class="review-card" data-id="${esc(r.id)}">
    <div class="review-thumb">${thumb(r)}</div>
    <div class="review-main">
      <div class="review-top">
        <span class="item-status ${r.type === 'Lost' ? 'lost' : ''}">${esc(r.type)}</span>
        <h3>${esc(r.name)}</h3>
        <span class="mono muted">${esc(timeAgo(String(r.createdAt).slice(0, 10)))}</span>
      </div>
      <p>${esc(r.description)}</p>
      <div class="meta-line">⌖ ${esc(r.location)} · ${esc(formatDate(r.date))} · ${esc(r.category)}</div>
      <div class="reporter-chip">👤 ${reporterLine(r.reporter)}</div>
    </div>
    <div class="review-actions">
      <button class="btn btn-primary btn-small" type="button" data-act="approve">✓ Approve</button>
      <button class="btn btn-danger btn-small" type="button" data-act="reject">Reject</button>
      <button class="btn btn-ghost btn-small" type="button" data-act="view">Details</button>
    </div>
  </article>`;
}

function claimCard(c) {
  return `<article class="claim-card" data-id="${esc(c.id)}" data-report="${esc(c.reportId)}">
    <div class="review-top">
      <span class="item-status ${c.itemType === 'Lost' ? 'lost' : ''}">${esc(c.itemType)}</span>
      <h3>${esc(c.itemName)}</h3>
      <span class="mono muted">${esc(timeAgo(String(c.createdAt).slice(0, 10)))}</span>
    </div>
    <div class="reporter-chip">🙋 ${reporterLine(c.by)}</div>
    <q>${esc(c.note)}</q>
    <div class="btn-row">
      <button class="btn btn-primary btn-small" type="button" data-act="handover">Verify &amp; hand over</button>
      <button class="btn btn-danger btn-small" type="button" data-act="reject-claim">Reject</button>
      <button class="btn btn-ghost btn-small" type="button" data-act="view">View item</button>
    </div>
  </article>`;
}

function renderReviews() {
  $('reviewList').innerHTML = S.reviews.map(reviewCard).join('');
  $('reviewEmpty').hidden = S.reviews.length > 0;
  $('tabPending').textContent = S.reviews.length;
}
function renderClaims() {
  $('claimList').innerHTML = S.claims.map(claimCard).join('');
  $('claimEmpty').hidden = S.claims.length > 0;
  $('tabClaims').textContent = S.claims.length;
}
function renderRecords() {
  $('recordsBody').innerHTML = S.records.map(r => `
    <tr data-id="${esc(r.id)}" tabindex="0">
      <td><strong>${esc(r.name)}</strong><small>${esc(r.location)}</small></td>
      <td><span class="item-status ${r.type === 'Lost' ? 'lost' : ''}">${esc(r.type)}</span></td>
      <td><span class="state-badge ${esc(r.status)}">${esc(STATUS_LABEL[r.status])}</span></td>
      <td>${esc(r.reporter.name)}<small>${esc(r.reporter.idNo || r.reporter.role)}</small></td>
      <td>${esc(formatDate(r.date))}</td>
      <td>${r.pendingClaims ? `<b class="claims-pill">${r.pendingClaims}</b>` : '—'}</td>
    </tr>`).join('');
  $('recordsEmpty').hidden = S.records.length > 0;
}

// ----- uncollected found items -----
const daysSince = s => {
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? 0 : Math.max(0, Math.round((Date.now() - d.getTime()) / 864e5));
};

function renderUncollected() {
  $('uncollectedBody').innerHTML = S.uncollected.map(r => {
    const days = daysSince(r.date);
    const wait = days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`;
    return `<tr data-id="${esc(r.id)}" tabindex="0">
      <td><strong>${esc(r.name)}</strong><small>${esc(r.category)}</small></td>
      <td>${esc(r.location)}</td>
      <td>${esc(formatDate(r.date))}</td>
      <td><span class="wait-chip ${days >= 7 ? 'long' : ''}">${esc(wait)}</span></td>
      <td><span class="state-badge ${esc(r.status)}">${esc(STATUS_LABEL[r.status])}</span></td>
      <td>${esc(r.reporter.name)}<small>${esc(r.reporter.idNo || r.reporter.role)}</small></td>
      <td>${r.pendingClaims ? `<b class="claims-pill">${r.pendingClaims}</b>` : '—'}</td>
    </tr>`;
  }).join('');
  $('uncollectedEmpty').hidden = S.uncollected.length > 0;
  $('tabUncollected').textContent = S.uncollected.length;
}

// ----- weekly / monthly reports -----
const KPI_DEFS = [
  ['reported', 'Reports received'], ['lost', 'Lost reports'], ['found', 'Found reports'],
  ['approved', 'Approved'], ['returned', 'Handed over'], ['claimsReceived', 'Claims received'],
  ['foundUncollected', 'Found, not collected']
];

function dayLabel(key, period) {
  const d = new Date(key + 'T12:00:00');
  return period === 'month'
    ? String(d.getDate())
    : d.toLocaleDateString('en-IN', { weekday: 'short' }) + ' ' + d.getDate();
}

function renderRank(el, rows, empty) {
  const max = Math.max(1, ...rows.map(r => r.count));
  el.innerHTML = rows.length
    ? rows.map(r => `<li><span class="rank-name">${esc(r.name)}</span><span class="rank-bar"><i data-w="${Math.round(r.count / max * 100)}"></i></span><b>${r.count}</b></li>`).join('')
    : `<li class="rank-empty">${empty}</li>`;
  qsa('[data-w]', el).forEach(i => { i.style.width = i.dataset.w + '%'; });
}

function renderSummary() {
  const s = S.summary;
  if (!s) return;
  qsa('.period-switch button').forEach(b => b.classList.toggle('active', b.dataset.period === S.period));
  $('periodLabel').textContent = s.label;
  $('periodNext').disabled = S.offset === 0;

  $('periodKpis').innerHTML = KPI_DEFS.map(([k, label]) =>
    `<div class="kpi ${k === 'foundUncollected' ? 'kpi-warn' : ''}"><small>${label}</small><strong>${s.totals[k]}</strong></div>`).join('');

  const max = Math.max(1, ...s.daily.map(d => Math.max(d.reported, d.returned)));
  $('periodChart').classList.toggle('dense', s.daily.length > 8);
  $('periodChart').innerHTML = s.daily.map(d => `
    <div class="bar-col" title="${esc(formatDate(d.date))}: ${d.reported} received, ${d.returned} handed over">
      <div class="bars">
        <i class="bar bar-a" data-h="${d.reported ? Math.max(4, Math.round(d.reported / max * 100)) : 0}"></i>
        <i class="bar bar-b" data-h="${d.returned ? Math.max(4, Math.round(d.returned / max * 100)) : 0}"></i>
      </div>
      <span class="bar-label">${esc(dayLabel(d.date, s.period))}</span>
    </div>`).join('');
  qsa('[data-h]', $('periodChart')).forEach(b => { b.style.height = b.dataset.h + '%'; });

  renderRank($('periodCategories'), s.byCategory, 'No reports yet.');
  renderRank($('periodLocations'), s.topLocations, 'No reports yet.');

  $('periodBody').innerHTML = s.reports.map(r => `
    <tr data-id="${esc(r.id)}" tabindex="0">
      <td><strong>${esc(r.name)}</strong><small>${esc(r.location)}</small></td>
      <td><span class="item-status ${r.type === 'Lost' ? 'lost' : ''}">${esc(r.type)}</span></td>
      <td><span class="state-badge ${esc(r.status)}">${esc(STATUS_LABEL[r.status])}</span></td>
      <td>${esc(r.reporter.name)}<small>${esc(r.reporter.idNo || r.reporter.role)}</small></td>
      <td>${esc(formatDate(String(r.createdAt).slice(0, 10)))}</td>
    </tr>`).join('');
  $('periodEmpty').hidden = s.reports.length > 0;
}

async function loadSummary() {
  S.summary = await api.get(`/admin/summary?period=${S.period}&offset=${S.offset}`);
  renderSummary();
}

async function loadRecords() {
  const p = new URLSearchParams();
  const q = $('recordSearch').value.trim();
  const status = $('recordStatus').value;
  if (q) p.set('q', q);
  if (status !== 'all') p.set('status', status);
  S.records = await api.get('/admin/reports?' + p);
  renderRecords();
}

async function refreshConsole() {
  const [stats, reviews, claims, uncollected] = await Promise.all([
    api.get('/admin/stats'),
    api.get('/admin/reports?status=pending'),
    api.get('/admin/claims?status=pending'),
    api.get('/admin/uncollected')
  ]);
  S.reviews = reviews;
  S.claims = claims;
  S.uncollected = uncollected;
  setCount($('kPending'), stats.pendingReports);
  setCount($('kClaims'), stats.pendingClaims);
  setCount($('kVerified'), stats.verified);
  setCount($('kReturned'), stats.returned);
  setCount($('kRejected'), stats.rejected);
  renderReviews();
  renderClaims();
  renderUncollected();
  await Promise.all([loadRecords(), loadSummary()]);
}

function initConsole() {
  qsa('.console-tab').forEach(t => t.addEventListener('click', () => {
    qsa('.console-tab').forEach(x => x.classList.toggle('active', x === t));
    qsa('.console-panel').forEach(p => { p.hidden = p.id !== t.dataset.panel; });
  }));

  $('reviewList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.review-card');
    if (!btn || !card) return;
    const id = card.dataset.id;
    const r = S.reviews.find(x => x.id === id);
    try {
      if (btn.dataset.act === 'approve') {
        btn.disabled = true;
        await api.patch(`/admin/reports/${id}/verify`);
        toast('Report approved and published.');
        refresh();
      } else if (btn.dataset.act === 'reject') openReject({ kind: 'report', id, label: r.name });
      else openDetail(id);
    } catch (err) { toast(err.message); btn.disabled = false; }
  });

  $('claimList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.claim-card');
    if (!btn || !card) return;
    const c = S.claims.find(x => x.id === card.dataset.id);
    if (btn.dataset.act === 'handover') openHandover({ id: c.reportId, name: c.itemName, type: c.itemType }, c);
    else if (btn.dataset.act === 'reject-claim') openReject({ kind: 'claim', id: c.id, label: `${c.by.name} → ${c.itemName}` });
    else openDetail(c.reportId);
  });

  const open = e => { const row = e.target.closest('tr[data-id]'); if (row) openDetail(row.dataset.id); };
  $('recordsBody').addEventListener('click', open);
  $('recordsBody').addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });

  const openRow = e => { const row = e.target.closest('tr[data-id]'); if (row) openDetail(row.dataset.id); };
  ['uncollectedBody', 'periodBody'].forEach(id => {
    $(id).addEventListener('click', openRow);
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') openRow(e); });
  });

  const reloadSummary = () => loadSummary().catch(err => toast(err.message));
  qsa('.period-switch button').forEach(b => b.addEventListener('click', () => {
    S.period = b.dataset.period; S.offset = 0; reloadSummary();
  }));
  $('periodPrev').addEventListener('click', () => { S.offset += 1; reloadSummary(); });
  $('periodNext').addEventListener('click', () => { if (S.offset > 0) { S.offset -= 1; reloadSummary(); } });
  $('periodExport').addEventListener('click', async () => {
    try {
      await download(`/admin/summary/export?period=${S.period}&offset=${S.offset}`,
        `back2you-${S.period}ly-report-${S.summary ? S.summary.from : localToday()}.csv`);
      toast('Report downloaded as CSV.');
    } catch (err) { toast(err.message); }
  });

  let timer;
  $('recordSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => loadRecords().catch(err => toast(err.message)), 250); });
  $('recordStatus').addEventListener('change', () => loadRecords().catch(err => toast(err.message)));

  $('exportBtn').addEventListener('click', async () => {
    const what = $('exportWhat').value, fmt = $('exportFormat').value;
    try {
      await download(`/admin/export/${what}?format=${fmt}`, `back2you-${what}-${new Date().toISOString().slice(0, 10)}.${fmt}`);
      toast(`${what} exported as ${fmt.toUpperCase()}.`);
    } catch (err) { toast(err.message); }
  });
}

// ===== AUTH =====
let role = 'student';

const ROLE_UI = {
  student: { label: 'Register number', placeholder: 'e.g. 211CS1045' },
  faculty: { label: 'Employee ID', placeholder: 'e.g. SRET1024' }
};

function setRole(next) {
  role = next;
  const mgmt = next === 'management';
  qsa('.role-switch button').forEach(b => {
    const on = b.dataset.role === next;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('memberForm').hidden = mgmt;
  $('mgmtForm').hidden = !mgmt;
  $('memberError').hidden = $('mgmtError').hidden = true;
  if (!mgmt) {
    $('memberIdLabel').textContent = ROLE_UI[next].label;
    $('memberId').placeholder = ROLE_UI[next].placeholder;
  }
}

async function signIn(url, payload, errorId, button, onSignedIn) {
  const box = $(errorId);
  box.hidden = true;
  button.disabled = true;
  try {
    const { user } = await api.post(url, payload);
    state.user = user;
    $('memberForm').reset();
    $('mgmtForm').reset();
    await onSignedIn();
  } catch (err) {
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function initAuth({ onSignedIn, onSignedOut }) {
  qsa('.role-switch button').forEach(b => b.addEventListener('click', () => setRole(b.dataset.role)));

  $('memberForm').addEventListener('submit', e => {
    e.preventDefault();
    signIn('/auth/login', {
      role, name: $('memberName').value, idNo: $('memberId').value,
      email: $('memberEmail').value, department: $('memberDept').value
    }, 'memberError', e.submitter, onSignedIn);
  });

  $('mgmtForm').addEventListener('submit', e => {
    e.preventDefault();
    signIn('/auth/login/management', { email: $('mgmtEmail').value, accessCode: $('mgmtCode').value },
      'mgmtError', e.submitter, onSignedIn);
  });

  $('signOutBtn').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    state.user = null;
    setRole('student');
    onSignedOut();
  });
}

// ===== MAIN =====
const signInScreen = $('signInScreen');
const appShell = $('appShell');

function showSignIn() {
  appShell.hidden = true;
  signInScreen.hidden = false;
  qsa('dialog[open]').forEach(d => closeDialog(d.id));
  window.scrollTo({ top: 0 });
}

function applyRole() {
  const u = state.user;
  const manager = isManager();
  $('profileName').textContent = u.name;
  $('profileMeta').textContent = manager ? 'Management' : `${u.role === 'faculty' ? 'Faculty' : 'Student'} · ${u.department}`;
  $('profileMeta').classList.toggle('role-badge', manager);
  $('profileAvatar').textContent = u.name.trim().charAt(0).toUpperCase();

  qsa('[data-mgmt]').forEach(el => { el.hidden = !manager; });
  qsa('[data-member]').forEach(el => { el.hidden = manager; });
  $('historyEyebrow').textContent = manager ? 'ALL CAMPUS ACTIVITY' : 'YOUR ACTIVITY';
  $('historySubtitle').textContent = manager
    ? 'Every report, verification, claim and handover on campus.'
    : 'Every report, claim and handover linked to you.';
}

async function refreshAll() {
  try {
    await Promise.all([loadBoard(), loadHistory(), isManager() ? refreshConsole() : null]);
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

async function enterPortal() {
  signInScreen.hidden = true;
  appShell.hidden = false;
  applyRole();
  setType('all');
  await refreshAll();
  toast(isManager() ? `Welcome, ${state.user.name}. Management tools are on.` : `Welcome to Back2You, ${state.user.name}!`);
}

function initChrome() {
  $('signOutBtn').addEventListener('click', () => { $('mobileNav').hidden = true; });

  $('mobileMenuBtn').addEventListener('click', () => {
    const open = $('mobileNav').hidden;
    $('mobileNav').hidden = !open;
    $('mobileMenuBtn').setAttribute('aria-expanded', String(open));
  });
  qsa('#mobileNav a').forEach(a => a.addEventListener('click', () => { $('mobileNav').hidden = true; }));

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !appShell.hidden) {
      e.preventDefault();
      $('searchInput').focus();
      $('browse').scrollIntoView({ behavior: 'smooth' });
    }
  });

  const header = document.querySelector('.site-header');
  window.addEventListener('scroll', () => {
    $('backTop').hidden = window.scrollY < 600;
    header.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });
  $('backTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: 0.15 });
    qsa('.step-card, .safety-card, .center-heading').forEach((el, i) => {
      el.classList.add('reveal');
      el.style.transitionDelay = (i % 4) * 70 + 'ms';
      io.observe(el);
    });
  }
}

async function boot() {
  bindDialogs();
  initAuth({ onSignedIn: enterPortal, onSignedOut: showSignIn });
  initBoard(); initReport(); initHistory(); initDetail(); initAdminDialogs(); initConsole(); initChrome();

  document.addEventListener('b2y:refresh', async e => {
    await refreshAll();
    const id = e.detail && e.detail.reopen;
    if (id && $('detailDialog').open) openDetail(id);
  });
  document.addEventListener('b2y:unauthorized', () => {
    if (state.user) { state.user = null; showSignIn(); toast('Your session expired. Please sign in again.'); }
  });

  try {
    const { user } = await api.get('/auth/me');
    state.user = user;
    signInScreen.hidden = true;
    appShell.hidden = false;
    applyRole();
    await refreshAll();
  } catch {
    showSignIn();
  }
}

boot();

})();