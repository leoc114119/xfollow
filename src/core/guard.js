// 限流护栏 + 熔断器。这个文件是核心功能,不是附加项。
//
// 上一轮的实测结论写在 README 里,这里把它变成代码:
//   跑约 5-6 次脚本请求后,网关开始对所有路径返回 403 空 body —— 这是"脚本请求被
//   识别",不是"账号被封"。当时的正确处理是立刻停手,账号毫发无伤。
//   硬闯才是账号被永久限制的主要路径。
// 所以:第一次看到限制信号就自我锁死,不重试、不降频硬闯。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const U = typeof module === 'object' && module.exports ? require('./util.js') : globalThis.XF;
  const L = typeof module === 'object' && module.exports ? require('./ledger.js') : globalThis.XF;

  // X 表达"你被限流了"的各种说法。
  // 分两档是有原因的:弱信号只在浮层里、且文本很短时才算数。
  // 整页 innerText 匹配弱信号会误伤 —— 个人主页里一条含 "try again later" 的推文
  // 就能把扩展锁 24 小时(审查已指出)。
  const STRONG_PATTERNS = [
    /rate limit/i,
    /unable to follow more people/i,
    /\bcode"?\s*:\s*(226|326)\b/,
    /looks like it might be automated/i,
    /protect our users from spam/i,
    /your account is temporarily/i,
    /this action is not allowed/i,
  ];
  const WEAK_PATTERNS = [/too many requests/i, /try again later/i];
  const LIMIT_PATTERNS = STRONG_PATTERNS.concat(WEAK_PATTERNS);

  function isLimitSignal(status, bodyText) {
    // 403 + 空 body 就是实测到的那个特征
    if (status === 403) {
      const t = String(bodyText || '').trim();
      if (t.length === 0) return 'HTTP 403 + 空响应(脚本请求识别)';
      if (LIMIT_PATTERNS.some((re) => re.test(t))) return 'HTTP 403: ' + t.slice(0, 120);
    }
    if (status === 429) return 'HTTP 429 限流';
    const t = String(bodyText || '');
    for (const re of STRONG_PATTERNS) {
      if (re.test(t)) return t.slice(0, 120);
    }
    // 弱信号必须伴随"文本很短",否则很可能只是正常内容里出现了这几个词
    if (t.length > 0 && t.length < 300) {
      for (const re of WEAK_PATTERNS) {
        if (re.test(t)) return t.slice(0, 120);
      }
    }
    return null;
  }

  /**
   * 只看**浮层**:toast、alert、确认弹层、对话框。
   *
   * 绝不能扫整页 innerText —— 那会把页面内容当成限流文案。
   * 这个函数在每次关注/取关之后都会跑,误判的代价是锁 24 小时。
   */
  function scanDomForLimit(rootEl) {
    const el = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!el || !el.body) return null;
    const sel =
      '[role="alert"], [role="dialog"], [data-testid="toast"], [data-testid="confirmationSheetConfirm"], [data-testid="sheetDialog"]';
    for (const node of el.querySelectorAll(sel)) {
      const t = (node.innerText || node.textContent || '').trim();
      // 浮层都很短;长文本说明我们选中了一个大容器,跳过
      if (!t || t.length > 400) continue;
      for (const re of STRONG_PATTERNS) {
        const m = t.match(re);
        if (m) return m[0];
      }
      for (const re of WEAK_PATTERNS) {
        const m = t.match(re);
        if (m) return m[0];
      }
    }
    return null;
  }

  function freshQuota(ts) {
    return {
      day: U.dayKey(ts),
      locked: false,
      lockReason: null,
      lockedAt: null,
      lockedUntil: null,
    };
  }

  // ── 存储访问 ───────────────────────────────────────────────
  // chrome.storage 没有跨上下文互斥:每个标签页、每个弹出面板都有自己的队列。
  // 所以这里做两件事把风险压到最小:
  //   1. 所有配额变更走 mutateQuota —— 读和写紧挨着,把竞态窗口压到毫秒级
  //   2. 取名一个"队列租约",保证同一时间只有一个上下文在跑取关
  const withLock = U.makeQueue();

  function rawGet(keys) {
    return new Promise((resolve) => {
      if (!U.chromeAlive() || !chrome.storage || !chrome.storage.local) return resolve({});
      chrome.storage.local.get(keys, (r) => resolve(r || {}));
    });
  }

  function rawSet(obj) {
    return new Promise((resolve) => {
      if (!U.chromeAlive() || !chrome.storage || !chrome.storage.local) return resolve();
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  /**
   * 读-改-写一次配额。fn 直接改传入的对象,返回 { write, result }。
   * 读和写之间**不做任何异步操作** —— 这是把竞态窗口压到最小的手段。
   */
  async function withQuota(fn) {
    return withLock(async () => {
      const q = normalize(await L.getQuota(), Date.now());
      const out = fn(q);
      if (out && out.write) await L.setQuota(q);
      return out ? out.result : undefined;
    });
  }

  async function mutateQuota(fn) {
    return withQuota((q) => {
      const next = fn(q) || q;
      return { write: true, result: next };
    });
  }

  /** 只读操作(扫描)的准入:只看熔断,不看写配额 —— 配额用满不该挡住只读扫描。 */
  async function canScan(ts) {
    const q = normalize(await L.getQuota(), ts || Date.now());
    if (!q.locked) return { ok: true };
    const left = q.lockedUntil ? Math.max(0, Math.ceil((q.lockedUntil - Date.now()) / 60000)) : null;
    return {
      ok: false,
      locked: true,
      lockedUntil: q.lockedUntil || null,
      minutesLeft: left,
      reason: `已暂停扫描:${q.lockReason || '触发限制信号'}${left ? `,还要等约 ${left} 分钟` : ''}`,
    };
  }

  function normalize(quota, ts) {
    const now = ts || Date.now();
    let q = quota || freshQuota(now);
    // 日配额按本地自然日重置
    if (q.day !== U.dayKey(now)) {
      q = Object.assign(freshQuota(now), { locked: q.locked, lockReason: q.lockReason, lockedAt: q.lockedAt, lockedUntil: q.lockedUntil });
    }
    // 熔断锁定过期就自动解开(默认 24 小时)。不设永久锁 —— 否则你第二天
    // 会以为工具坏了,然后手动去别处硬闯,反而更糟。
    if (q.locked && q.lockedUntil && now >= q.lockedUntil) {
      q = Object.assign({}, q, { locked: false, lockReason: null, lockedAt: null, lockedUntil: null });
    }
    return q;
  }

  /**
   * 熔断该停多久。
   *
   * 这道锁的目的只是**让我别接着撞**,不是惩罚用户。所以它必须短到能自愈:
   *   · 429 是常规限流,X 自己十几分钟就放开了 → 停 15 分钟
   *   · 403 + 空响应那个特征历史上会持续一阵 → 停 45 分钟
   * 真被挡着的话,时间到了再扫一次会立刻重新触发 —— 自己就会纠回来。
   * 原来写死 24 小时是错的:一次偶发的 429 就把工具锁一整天,而用户没有任何办法解开。
   */
  function lockMinutesFor(signal) {
    const t = String(signal || '');
    if (t.indexOf('429') !== -1) return 15;
    return 45;
  }

  /** 熔断。看到第一个限制信号就调它,不要重试。 */
  async function trip(reason, config, ts, minutes) {
    const now = ts || Date.now();
    const mins = minutes || lockMinutesFor(reason);
    return mutateQuota((q) => {
      q.locked = true;
      q.lockReason = reason || '触发限制信号';
      q.lockedAt = now;
      q.lockedUntil = now + mins * 60 * 1000;
      return q;
    });
  }

  async function manualUnlock() {
    return mutateQuota((q) => {
      q.locked = false;
      q.lockReason = null;
      q.lockedAt = null;
      q.lockedUntil = null;
      return q;
    });
  }

  async function status(ts) {
    const now = ts || Date.now();
    const q = normalize(await L.getQuota(), now);
    return {
      quota: q,
      locked: !!q.locked,
      reason: q.lockReason || null,
      lockedUntil: q.lockedUntil || null,
    };
  }

  return {
    isLimitSignal,
    scanDomForLimit,
    canScan,
    trip,
    lockMinutesFor,
    manualUnlock,
    status,
    normalize,
    LIMIT_PATTERNS,
    STRONG_PATTERNS,
    WEAK_PATTERNS,
  };
});
