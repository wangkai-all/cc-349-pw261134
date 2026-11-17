// 门户数据层 —— 全部为虚构数据（配送交付单）。
// 关键点：源数据在查看期间会变化（mutate），且门户【不提供】跨接口的统一快照。
// 每行有独立 rowVersion，summary 与 details 两个接口各自返回自己看到的版本。

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['华东', '华北', '华南', '西南'];
const STATUSES = ['待交付', '配送中', '已交付', '异常'];
const CUSTOMERS = [
  '云杉物流', '北辰商贸', '澄海食品', '岚山制造', '汀兰电商', '沐阳家居',
  '白鹭冷链', '青禾农业', '曜石科技', '栖霞纺织', '澄迈五金', '蓝鲸汽配',
];
const PRODUCTS = [
  { sku: 'SKU-1001', name: '无线蓝牙耳机' },
  { sku: 'SKU-1002', name: '智能手环' },
  { sku: 'SKU-1003', name: '便携充电器' },
  { sku: 'SKU-1004', name: '机械键盘' },
  { sku: 'SKU-1005', name: '办公椅靠垫' },
  { sku: 'SKU-1006', name: '不锈钢保温杯' },
  { sku: 'SKU-1007', name: 'LED 台灯' },
  { sku: 'SKU-1008', name: '收纳箱（大）' },
];

export function createDataStore(rowCount = 60) {
  const rnd = mulberry32(20261118);
  const rows = new Map(); // rowId -> row
  let seq = 0; // 全局单调序号：每次数据变化 +1，仅用于观察变化顺序，不是快照令牌
  let reqCounter = 0;

  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  function makeLines() {
    const n = 1 + Math.floor(rnd() * 4);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const p = pick(PRODUCTS);
      const qty = 1 + Math.floor(rnd() * 8);
      const unitPriceCents = (10 + Math.floor(rnd() * 490)) * 100;
      lines.push({ sku: p.sku, name: p.name, qty, unitPriceCents, amountCents: qty * unitPriceCents });
    }
    const freight = (3 + Math.floor(rnd() * 25)) * 100;
    lines.push({ sku: 'FREIGHT', name: '运费', qty: 1, unitPriceCents: freight, amountCents: freight });
    return lines;
  }
  const sumLines = (lines) => lines.reduce((s, l) => s + l.amountCents, 0);

  for (let i = 0; i < rowCount; i++) {
    const rowId = `DO-${1001 + i}`;
    const lines = makeLines();
    rows.set(rowId, {
      rowId,
      region: pick(REGIONS),
      customer: pick(CUSTOMERS),
      status: pick(STATUSES),
      lines,
      amountCents: sumLines(lines),
      rowVersion: 1,
      updatedAt: new Date(Date.now() - Math.floor(rnd() * 86400000)).toISOString(),
    });
  }

  function nextRequestId() {
    reqCounter += 1;
    return `req-${Date.now().toString(36)}-${reqCounter}`;
  }

  // 变更一行：版本 +1，金额/明细/状态变化。模拟"查看期间源数据变化"。
  function mutateRow(rowId, why = 'background-mutator') {
    const row = rows.get(rowId);
    if (!row) return null;
    const line = row.lines[Math.floor(rnd() * (row.lines.length - 1))]; // 不动运费行
    line.qty = 1 + Math.floor(rnd() * 8);
    line.amountCents = line.qty * line.unitPriceCents;
    row.amountCents = sumLines(row.lines);
    if (rnd() < 0.3) row.status = pick(STATUSES);
    row.rowVersion += 1;
    row.updatedAt = new Date().toISOString();
    seq += 1;
    return { rowId, rowVersion: row.rowVersion, seq, why };
  }

  function randomMutate(why) {
    const ids = [...rows.keys()];
    return mutateRow(ids[Math.floor(rnd() * ids.length)], why);
  }

  // 汇总接口：只返回行的汇总视图（含当前 rowVersion）。无快照令牌。
  function summary({ region = '', status = '', offset = 0, limit = 12 }) {
    let list = [...rows.values()];
    if (region) list = list.filter((r) => r.region === region);
    if (status) list = list.filter((r) => r.status === status);
    const total = list.length;
    const page = list.slice(offset, offset + limit).map((r) => ({
      rowId: r.rowId,
      region: r.region,
      customer: r.customer,
      status: r.status,
      amountCents: r.amountCents,
      rowVersion: r.rowVersion,
      updatedAt: r.updatedAt,
    }));
    return {
      requestId: nextRequestId(),
      asOf: new Date().toISOString(),
      seq,
      filterEcho: { region, status },
      offset, limit, total,
      rows: page,
    };
  }

  // 明细接口：独立返回该行【当前】版本——可能与此前 summary 看到的版本不同。
  function details(rowId) {
    const row = rows.get(rowId);
    if (!row) return null;
    return {
      requestId: nextRequestId(),
      asOf: new Date().toISOString(),
      seq,
      rowId: row.rowId,
      rowVersion: row.rowVersion,
      customer: row.customer,
      status: row.status,
      amountCents: row.amountCents,
      lines: row.lines.map((l) => ({ ...l })),
    };
  }

  return {
    rows, summary, details, mutateRow, randomMutate, nextRequestId,
    get seq() { return seq; },
    regions: REGIONS, statuses: STATUSES,
  };
}
