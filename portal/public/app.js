// 门户单页应用：虚拟滚动列表（DOM 槽位复用）+ 行展开明细。
// 汇总行走 /api/summary，展开明细走 /api/rows/:id/details —— 两个接口，无统一快照。

const ROW_H = 38;          // 行高（未展开）
const PAGE = 12;           // 每页汇总行数
const POOL = 16;           // DOM 槽位池大小（滚动时复用）
const DETAIL_LINE_H = 24;

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');

const state = {
  filter: { region: '', status: '' },
  total: 0,
  pages: new Map(),        // pageIdx -> rows[]
  pendingPages: new Set(),
  heights: [],             // 每个逻辑行的高度
  offsets: [],             // 前缀和
  expanded: new Map(),     // rowId -> {status:'loading'|'ok'|'error', lines?, rowVersion?, requestId?, error?}
  slots: [],               // DOM 槽位池
};

const fmtYuan = (cents) => '¥' + (cents / 100).toFixed(2);

// ---------- 虚拟列表骨架 ----------
function initSlots() {
  for (let i = 0; i < POOL; i++) {
    const el = document.createElement('div');
    el.className = 'vrow';
    el.dataset.domSlot = String(i);
    el._pool = i;
    el._index = -1;
    canvas.appendChild(el);
    state.slots.push(el);
  }
}

function computeOffsets() {
  state.offsets = new Array(state.total + 1);
  let acc = 0;
  for (let i = 0; i < state.total; i++) {
    state.offsets[i] = acc;
    acc += state.heights[i] ?? ROW_H;
  }
  state.offsets[state.total] = acc;
  canvas.style.height = acc + 'px';
}

function rowAt(index) {
  const pageIdx = Math.floor(index / PAGE);
  const page = state.pages.get(pageIdx);
  return page?.[index - pageIdx * PAGE];
}

function visibleRange() {
  const y = viewport.scrollTop;
  const h = viewport.clientHeight;
  let lo = 0, hi = state.total - 1, first = 0;
  while (lo <= hi) { // 二分找第一个底边超过 y 的行
    const mid = (lo + hi) >> 1;
    if (state.offsets[mid + 1] > y) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  let last = first;
  while (last < state.total - 1 && state.offsets[last + 1] < y + h) last++;
  return [first, Math.min(last + 1, state.total - 1)];
}

function render() {
  if (state.total === 0) { canvas.style.height = '0px'; return; }
  const [first, last] = visibleRange();
  for (let i = first; i <= last; i++) {
    ensurePage(Math.floor(i / PAGE));
    const slot = state.slots[i % POOL];
    // 槽位复用：索引变了要重渲染；占位渲染的槽位在数据到达后也要重渲染
    if (slot._index !== i || (slot._needsData && rowAt(i))) fillSlot(slot, i);
    slot.style.transform = `translateY(${state.offsets[i]}px)`;
    slot.style.height = (state.heights[i] ?? ROW_H) + 'px';
  }
}

function fillSlot(slot, i) {
  slot._index = i;
  const row = rowAt(i);
  slot._needsData = !row; // 占位状态：数据到达后由 render 重新填充
  slot.dataset.rowId = row?.rowId ?? '';
  slot.dataset.rowVersion = row ? String(row.rowVersion) : '';
  if (!row) {
    slot.innerHTML = `<div class="summary-line loading">加载中… (#${i})</div>`;
    return;
  }
  const exp = state.expanded.get(row.rowId);
  const open = Boolean(exp);
  let html = `
    <div class="summary-line vrow-grid" data-action="toggle">
      <span class="expander">${open ? '▾' : '▸'}</span>
      <span class="mono">${row.rowId}</span>
      <span>${row.customer}</span>
      <span>${row.region}</span>
      <span class="num">${fmtYuan(row.amountCents)}</span>
      <span><em class="st st-${row.status}">${row.status}</em></span>
      <span class="ver">v${row.rowVersion}</span>
      <span class="ts">${row.updatedAt.slice(11, 19)}</span>
    </div>`;
  if (open) {
    html += `<div class="detail-box">${renderDetail(row.rowId, exp)}</div>`;
  }
  slot.innerHTML = html;
}

function renderDetail(rowId, exp) {
  if (exp.status === 'loading') return `<div class="detail-loading">明细加载中…</div>`;
  if (exp.status === 'error') return `<div class="detail-error">明细加载失败：${exp.error}</div>`;
  const rows = exp.lines.map((l) => `
    <tr><td class="mono">${l.sku}</td><td>${l.name}</td><td class="num">${l.qty}</td>
    <td class="num">${fmtYuan(l.unitPriceCents)}</td><td class="num">${fmtYuan(l.amountCents)}</td></tr>`).join('');
  return `
    <div class="detail-meta">明细版本 v${exp.rowVersion} · 请求 ${exp.requestId}</div>
    <table class="lines">
      <thead><tr><th>SKU</th><th>品名</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------- 数据加载 ----------
async function ensurePage(pageIdx) {
  if (state.pages.has(pageIdx) || state.pendingPages.has(pageIdx)) return;
  state.pendingPages.add(pageIdx);
  const q = new URLSearchParams({
    region: state.filter.region, status: state.filter.status,
    offset: String(pageIdx * PAGE), limit: String(PAGE),
  });
  try {
    const resp = await fetch('/api/summary?' + q);
    const data = await resp.json();
    state.pages.set(pageIdx, data.rows);
    if (data.total !== state.total) {
      state.total = data.total;
      state.heights = Array.from({ length: state.total }, (_, i) => state.heights[i] ?? ROW_H);
      document.getElementById('total-label').textContent = `共 ${state.total} 行`;
    }
    computeOffsets();
  } finally {
    state.pendingPages.delete(pageIdx);
  }
  render();
}

// ---------- 行展开 ----------
function rowIndexOf(rowId) {
  for (const [pageIdx, rows] of state.pages) {
    const j = rows.findIndex((r) => r.rowId === rowId);
    if (j >= 0) return pageIdx * PAGE + j;
  }
  return -1;
}

function expandedHeight(rowId) {
  const exp = state.expanded.get(rowId);
  if (!exp) return ROW_H;
  if (exp.status !== 'ok') return ROW_H + 64;
  return ROW_H + 40 + DETAIL_LINE_H * (exp.lines.length + 1) + 16;
}

async function expandRow(rowId) {
  const idx = rowIndexOf(rowId);
  if (idx < 0) return false;
  state.expanded.set(rowId, { status: 'loading' });
  state.heights[idx] = expandedHeight(rowId);
  computeOffsets(); render();
  try {
    const resp = await fetch(`/api/rows/${encodeURIComponent(rowId)}/details`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    state.expanded.set(rowId, {
      status: 'ok', lines: data.lines, rowVersion: data.rowVersion, requestId: data.requestId,
    });
  } catch (e) {
    state.expanded.set(rowId, { status: 'error', error: String(e.message || e) });
  }
  const idx2 = rowIndexOf(rowId);
  if (idx2 >= 0) state.heights[idx2] = expandedHeight(rowId);
  computeOffsets(); render();
  return true;
}

function collapseRow(rowId) {
  const idx = rowIndexOf(rowId);
  state.expanded.delete(rowId);
  if (idx >= 0) state.heights[idx] = ROW_H;
  computeOffsets(); render();
}

// ---------- 事件 ----------
viewport.addEventListener('scroll', () => render());

canvas.addEventListener('click', (e) => {
  const line = e.target.closest('[data-action="toggle"]');
  if (!line) return;
  const slot = line.closest('.vrow');
  const rowId = slot?.dataset.rowId;
  if (!rowId) return;
  state.expanded.has(rowId) ? collapseRow(rowId) : expandRow(rowId);
});

document.getElementById('filter-bar').addEventListener('submit', (e) => {
  e.preventDefault();
  state.filter = {
    region: document.getElementById('f-region').value,
    status: document.getElementById('f-status').value,
  };
  state.pages.clear(); state.expanded.clear();
  state.total = 0; state.heights = [];
  for (const s of state.slots) s._index = -1;
  viewport.scrollTop = 0;
  ensurePage(0);
});

// ---------- 侧栏：源数据变化流 ----------
async function pollState() {
  try {
    const s = await (await fetch('/api/state')).json();
    document.getElementById('seq-label').textContent = `服务器变更序号 seq=${s.seq}`;
    document.getElementById('change-log').innerHTML = s.recentChanges
      .map((c) => `<li><span class="mono">${c.rowId}</span> → v${c.rowVersion} <span class="why">${c.why}</span></li>`)
      .join('');
  } catch { /* 忽略 */ }
}

// ---------- 初始化 ----------
async function init() {
  // 支持 URL 携带筛选条件（可分享的筛选视图）：/?region=华东&status=
  const params = new URLSearchParams(location.search);
  state.filter = { region: params.get('region') || '', status: params.get('status') || '' };
  const regionSel = document.getElementById('f-region');
  const statusSel = document.getElementById('f-status');
  for (const r of ['华东', '华北', '华南', '西南']) regionSel.add(new Option(r, r));
  for (const s of ['待交付', '配送中', '已交付', '异常']) statusSel.add(new Option(s, s));
  regionSel.value = state.filter.region;
  statusSel.value = state.filter.status;
  initSlots();
  computeOffsets();
  ensurePage(0);
  setInterval(pollState, 2000);
  pollState();
}

// 暴露给采集器/调试：DOM 槽位复用可观测
window.__app = {
  state, expandRow, collapseRow, rowIndexOf,
  slotMap: () => state.slots.map((s) => ({
    slot: s._pool, index: s._index, rowId: s.dataset.rowId || null,
    rowVersion: s.dataset.rowVersion ? Number(s.dataset.rowVersion) : null,
  })),
};

init();
