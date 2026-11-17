// 核对逻辑单测：绑定检查、行级判定、两条红线
//  红线1：汇总金额相等 ≠ 明细完整（金额勾稽只是参考信号）
//  红线2：展开失败 ≠ 没有明细
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRow, bindingErrors, batchLimitation, STATUS, MAX_ROUNDS } from '../verifier/verify.js';
import { createStore } from '../verifier/store.js';

const batch = { run_id: 'run-t', filter: { region: '华东', status: '' } };

function summaryArt(over = {}) {
  return {
    kind: 'summary',
    request: { url: 'http://p/api/summary?region=华东&offset=0&limit=12' },
    response: {
      status: 200,
      body: {
        requestId: 'req-1', filterEcho: { region: '华东', status: '' },
        collectAction: 'run-t:3', rows: [],
        ...over.responseBody,
      },
    },
    outcome: 'ok',
    ...over.fields,
  };
}

function detailArt(over = {}) {
  return {
    kind: 'detail',
    request: { url: 'http://p/api/rows/DO-1/details' },
    response: {
      status: 200,
      body: { requestId: 'req-2', rowId: 'DO-1', rowVersion: 2, amountCents: 500, collectAction: 'run-t:4', ...over.responseBody },
    },
    outcome: 'ok',
    ...over.fields,
  };
}

test('绑定：筛选条件回显不符 → 拒收', () => {
  const a = summaryArt({ responseBody: { filterEcho: { region: '华北', status: '' } } });
  assert.ok(bindingErrors(a, batch).includes('filter_mismatch'));
});

test('绑定：缺少采集动作关联回显 → 拒收', () => {
  const a = summaryArt({ responseBody: { collectAction: null } });
  assert.ok(bindingErrors(a, batch).includes('missing_action_echo'));
});

test('绑定：关联回显属于别的运行 → 拒收', () => {
  const a = summaryArt({ responseBody: { collectAction: 'run-x:1' } });
  assert.ok(bindingErrors(a, batch).includes('action_echo_mismatch'));
});

test('绑定：明细响应的行与请求的行不一致 → 拒收', () => {
  const a = detailArt({ responseBody: { rowId: 'DO-2' } });
  assert.ok(bindingErrors(a, batch).includes('row_binding_mismatch'));
});

test('绑定：完全一致的证据无错误', () => {
  assert.deepEqual(bindingErrors(summaryArt(), batch), []);
  assert.deepEqual(bindingErrors(detailArt(), batch), []);
});

const sumObs = (v = 2, amount = 500) => [{ rowVersion: v, amountCents: amount, requestId: 'r1', bindingErrors: [] }];
const detOk = (v = 2, amount = 500, extra = {}) => ({ outcome: 'ok', rowVersion: v, amountCents: amount, requestId: 'r2', bindingErrors: [], ...extra });
const detTimeout = () => ({ outcome: 'timeout', bindingErrors: [] });

test('判定：版本一致 + 金额勾稽相符 → 已核对', () => {
  const r = assessRow({ summary: sumObs(), details: [detOk()] });
  assert.equal(r.status, STATUS.VERIFIED);
  assert.equal(r.reconciles, true);
});

test('红线1：金额相等但版本不一致 → 不能判已核对', () => {
  // 明细合计恰好等于汇总金额，但版本不同 —— 金额勾稽不能代替完整性
  const r1 = assessRow({ summary: sumObs(2), details: [detOk(3, 500)] });
  assert.notEqual(r1.status, STATUS.VERIFIED);
  assert.equal(r1.action, 'retry');
  const r3 = assessRow({ summary: sumObs(2), details: [detOk(3, 500), detOk(4, 500), detOk(5, 500)] });
  assert.equal(r3.status, STATUS.UNCERTAIN);
  assert.equal(r3.reason, 'version_drift');
  assert.ok(r3.limitation.includes('统一快照'));
});

test('红线1：绑定失败即使金额相等也不采信', () => {
  const r = assessRow({ summary: sumObs(), details: [detOk(2, 500, { bindingErrors: ['row_binding_mismatch'] })] });
  assert.equal(r.status, STATUS.UNCERTAIN);
  assert.equal(r.reason, 'binding_error');
});

test('判定：版本一致但金额勾稽不符 → 不确定（完整性警报）', () => {
  const r = assessRow({ summary: sumObs(2, 500), details: [detOk(2, 999)] });
  assert.equal(r.status, STATUS.UNCERTAIN);
  assert.equal(r.reason, 'amount_inconsistent');
});

test('红线2：展开超时 ≠ 没有明细（先反复核对，终态为明细缺失）', () => {
  const r1 = assessRow({ summary: sumObs(), details: [detTimeout()] });
  assert.equal(r1.status, STATUS.RECHECKING);
  assert.equal(r1.action, 'retry');
  const rMax = assessRow({ summary: sumObs(), details: Array(MAX_ROUNDS).fill(detTimeout()) });
  assert.equal(rMax.status, STATUS.INCOMPLETE);
  assert.ok(rMax.limitation.includes('不代表该行无明细'));
});

test('判定：超时之后又成功 → 以最新成功为准', () => {
  const r = assessRow({ summary: sumObs(), details: [detTimeout(), detOk()] });
  assert.equal(r.status, STATUS.VERIFIED);
});

test('判定：未展开 → 待核对（明细情况未知）', () => {
  const r = assessRow({ summary: sumObs(), details: [] });
  assert.equal(r.status, STATUS.PENDING);
});

test('批次限制说明：全已核对时为 null，有不确定/缺失时成文', () => {
  assert.equal(batchLimitation([{ status: 'verified' }, { status: 'verified' }]), null);
  const text = batchLimitation([{ status: 'verified' }, { status: 'uncertain' }, { status: 'incomplete' }]);
  assert.ok(text.includes('统一快照'));
  assert.ok(text.includes('1 行反复核对后仍不确定'));
  assert.ok(text.includes('1 行明细获取失败'));
});

test('存储：证据提交幂等（同一 artifactId 不重复入库）', () => {
  const store = createStore(':memory:');
  store.ensureBatch({ runId: 'r', filter: {}, collector: 't' });
  const a = { artifactId: 'abc', runId: 'r', kind: 'detail', rowId: 'DO-1', outcome: 'ok', requestId: 'q1' };
  assert.equal(store.insertArtifact(a).duplicate, false);
  assert.equal(store.insertArtifact(a).duplicate, true);
  assert.equal(store.artifactsForRow('r', 'DO-1').length, 1);
  store.close();
});

test('存储：行状态可更新并留痕事件', () => {
  const store = createStore(':memory:');
  store.ensureBatch({ runId: 'r', filter: {}, collector: 't' });
  store.saveRowState('r', 'DO-1', { status: 'pending', rounds: 0 });
  store.saveRowState('r', 'DO-1', { status: 'verified', rounds: 1, summaryVersion: 2, detailVersion: 2, reconciles: true });
  const row = store.getRow('r', 'DO-1');
  assert.equal(row.status, 'verified');
  assert.equal(row.reconciles, 1);
  store.addEvent('r', 'DO-1', 'row_status', '状态：pending → verified', null);
  assert.equal(store.eventsForRow('r', 'DO-1').length, 1);
  store.close();
});
