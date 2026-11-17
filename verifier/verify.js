// 核对逻辑（纯函数，可单测）。
// 原则：
//  1. 不用"汇总金额 == 明细合计"代替明细完整性 —— 金额勾稽只是参考信号。
//  2. 展开失败（超时/5xx）≠ 没有明细 —— 记为"明细获取失败"，而不是 0 条明细。
//  3. 来源不提供统一快照时：先反复核对（retry），超过轮次仍不一致则保留为
//     "不确定"批次，并显式记录限制说明。

export const MAX_ROUNDS = 3;

export const STATUS = {
  PENDING: 'pending',         // 尚未展开：明细情况未知
  RECHECKING: 'rechecking',   // 发现不一致/失败，等待反复核对
  VERIFIED: 'verified',       // 绑定一致且版本一致
  UNCERTAIN: 'uncertain',     // 反复核对后仍不确定：保留证据 + 限制说明
  INCOMPLETE: 'incomplete',   // 明细获取失败（不等于无明细）
};

const TERMINAL = new Set([STATUS.VERIFIED, STATUS.UNCERTAIN, STATUS.INCOMPLETE]);
export const isTerminal = (s) => TERMINAL.has(s);

// ---- 绑定检查：证据是否属于这个批次、这一行 ----
export function bindingErrors(artifact, batch) {
  const errs = [];
  const f = batch?.filter ?? {};
  const { kind, request, response } = artifact;

  if (kind === 'summary' || kind === 'detail') {
    // 关联回显：响应必须证明它对应本次采集运行的某个动作
    const echo = response?.body?.collectAction;
    if (artifact.outcome === 'ok') {
      if (!echo) errs.push('missing_action_echo');
      else if (!String(echo).startsWith(`${batch.run_id}:`)) errs.push('action_echo_mismatch');
    }
  }

  if (kind === 'summary') {
    const echo = response?.body?.filterEcho;
    if (!echo) {
      errs.push('summary_missing_filter_echo');
    } else if ((echo.region || '') !== (f.region || '') || (echo.status || '') !== (f.status || '')) {
      errs.push('filter_mismatch'); // 响应里的筛选条件与采集声明不一致
    }
    if (!response?.body?.requestId) errs.push('missing_request_id');
    if (!Array.isArray(response?.body?.rows)) errs.push('summary_rows_missing');
  }

  if (kind === 'detail') {
    const m = /\/api\/rows\/([^/]+)\/details/.exec(request?.url || '');
    if (!m) errs.push('detail_url_row_missing');
    const bodyRow = response?.body?.rowId;
    if (m && bodyRow && decodeURIComponent(m[1]) !== bodyRow) {
      errs.push('row_binding_mismatch'); // 请求的行与返回的行不一致
    }
    if (artifact.outcome === 'ok' && !response?.body?.requestId) errs.push('missing_request_id');
  }
  return errs;
}

// ---- 行级判定 ----
// observations: { summary: [...], details: [...] }（按捕获时间升序）
//   summary[i]: { rowVersion, amountCents, requestId, bindingErrors }
//   details[i]: { outcome: 'ok'|'timeout'|'http_error', rowVersion?, amountCents?, requestId?, bindingErrors }
export function assessRow({ summary, details }) {
  const latestSummary = summary[summary.length - 1];
  const rounds = details.length; // 每次展开尝试计一轮
  const successes = details.filter((d) => d.outcome === 'ok');
  const latest = successes[successes.length - 1];

  const base = {
    rounds,
    summaryVersion: latestSummary?.rowVersion ?? null,
    detailVersion: latest?.rowVersion ?? null,
    reconciles: null, // 参考信号：版本一致且金额勾稽相符
    action: 'none',
    limitation: null,
  };

  if (!latestSummary) {
    return { ...base, status: STATUS.PENDING, reason: 'no_summary_observation' };
  }

  if (latest) {
    if (latest.bindingErrors?.length) {
      // 绑定都错了，金额再相等也不作数
      return {
        ...base, status: STATUS.UNCERTAIN, reason: 'binding_error',
        limitation: `明细证据绑定失败（${latest.bindingErrors.join(',')}）；金额勾稽不能作为采信依据`,
      };
    }
    if (latest.rowVersion === latestSummary.rowVersion) {
      const reconciles = latest.amountCents === latestSummary.amountCents;
      if (!reconciles) {
        return {
          ...base, status: STATUS.UNCERTAIN, reason: 'amount_inconsistent', reconciles: false,
          limitation: '汇总与明细版本一致但金额勾稽不符，疑似源数据损坏',
        };
      }
      return { ...base, status: STATUS.VERIFIED, reason: 'version_match', reconciles: true };
    }
    // 版本不一致：源数据在两次读取之间发生了变化 —— 反复核对
    if (rounds < MAX_ROUNDS) {
      return { ...base, status: STATUS.RECHECKING, reason: 'version_mismatch', action: 'retry' };
    }
    return {
      ...base, status: STATUS.UNCERTAIN, reason: 'version_drift',
      limitation: `来源不提供统一快照，反复核对 ${rounds} 轮后汇总(v${base.summaryVersion})与明细(v${base.detailVersion})仍不一致；已保留各版本证据`,
    };
  }

  if (details.length) {
    // 有展开尝试但全部失败 —— 明确不是"没有明细"
    if (rounds < MAX_ROUNDS) {
      return { ...base, status: STATUS.RECHECKING, reason: 'detail_fetch_failed', action: 'retry' };
    }
    const kinds = [...new Set(details.map((d) => d.outcome))].join('/');
    return {
      ...base, status: STATUS.INCOMPLETE, reason: 'detail_fetch_failed',
      limitation: `明细获取失败（${kinds}），重试 ${rounds} 轮未成功；不代表该行无明细`,
    };
  }

  return { ...base, status: STATUS.PENDING, reason: 'not_expanded' };
}

// ---- 批次限制说明（页面显式展示） ----
export function batchLimitation(rows) {
  const uncertain = rows.filter((r) => r.status === STATUS.UNCERTAIN);
  const incomplete = rows.filter((r) => r.status === STATUS.INCOMPLETE);
  const pending = rows.filter((r) => r.status === STATUS.PENDING || r.status === STATUS.RECHECKING);
  if (!uncertain.length && !incomplete.length && !pending.length) return null;
  const parts = [];
  if (uncertain.length) parts.push(`${uncertain.length} 行反复核对后仍不确定（已保留各版本证据）`);
  if (incomplete.length) parts.push(`${incomplete.length} 行明细获取失败（不代表无明细）`);
  if (pending.length) parts.push(`${pending.length} 行尚未完成核对`);
  return `来源系统不提供统一快照，本批次存在限制：${parts.join('；')}`;
}
