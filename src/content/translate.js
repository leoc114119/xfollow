// 端侧翻译引擎的封装(Chrome Translator API,稳定版自 Chrome 138)。
//
// 边界(TRANSLATE-DESIGN.md v2,两份评审定稿):
//   · 只认**隔离世界**自己的 `self.Translator` —— 隔离世界没有就是"此环境暂不支持",
//     不换通道、不找 MAIN 世界、不经 DOM 事件(草稿正文不许暴露给页面);
//   · 文本只在内存里走一圈:不落盘、不发往任何服务器、不进异常消息之外的地方;
//   · `create()` 需要用户激活 ⇒ 必须在真实点击的调用链里调;
//   · 翻译是异步的,剪贴板的激活窗口(约 5 秒)等不回它 —— 所以"翻译完成"和
//     "已复制"是两个独立状态,这里只负责如实报翻译本身,复制是调用方的事。
//
// P0a 探针也走这一份(它不是一次性的:正式功能用的就是这几个函数)。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PAIR = { sourceLanguage: 'zh', targetLanguage: 'en' };
  // ⚠ 超时是**实测出来的必需品**,不是防御式编程:有的环境里 `self.Translator` 存在,
  // 但 availability() 对任何语言对都不返回(已在本机一个 Chromium 环境实测复现)。
  // 不设上限的话,读数永远停在「?」、按钮永远「翻译中…」—— 又一个静默失败。
  // create 给得宽(首次要下载语言包,分钟级是正常的);两段分开记时。
  const AVAIL_TIMEOUT_MS = 8000;
  const CREATE_TIMEOUT_MS = 90000;
  const TRANSLATE_TIMEOUT_MS = 30000;

  function withTimeout(p, ms, label) {
    return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(label), ms))]);
  }

  function engine() {
    try {
      return (typeof self !== 'undefined' && self.Translator) || null;
    } catch {
      return null;
    }
  }

  /**
   * T1:能力读数。**纯读** —— 不 create、不碰草稿、不需要激活。
   * 'no-api' = 此环境(隔离世界)没有这个 API;'timeout' = API 在但不返回(也算不可用);
   * 其余原样透传 Chrome 的读数('available' / 'downloadable' / 'downloading' / 'unavailable')。
   */
  async function availabilityOf(pair, opts) {
    const T = engine();
    if (!T || typeof T.availability !== 'function') return 'no-api';
    const ms = (opts && opts.timeoutMs) || AVAIL_TIMEOUT_MS;
    try {
      const v = await withTimeout(T.availability(Object.assign({}, PAIR, pair || {})), ms, 'timeout');
      return String(v);
    } catch (e) {
      return 'error:' + String((e && e.message) || e);
    }
  }

  /**
   * T4 / 正式翻译:在**当前点击的手势里** create,然后 translate。
   * 返回 {ok, text?, msCreate, ms, reason?, stage?, error?}。失败必须如实 ——
   * "模型在下载"不许被报成"翻译完成",超时也要有自己的 reason,不许挂着。
   */
  async function translateText(text, opts) {
    const T = engine();
    const t0 = Date.now();
    if (!T || typeof T.create !== 'function') {
      return { ok: false, reason: 'no-api', msCreate: 0, ms: 0 };
    }
    const body = typeof text === 'string' ? text : text == null ? '' : String(text);
    if (!body.trim()) return { ok: false, reason: 'empty', msCreate: 0, ms: Date.now() - t0 };
    const createMs = (opts && opts.createTimeoutMs) || CREATE_TIMEOUT_MS;
    const translateMs = (opts && opts.translateTimeoutMs) || TRANSLATE_TIMEOUT_MS;
    let tr = null;
    try {
      const made = await withTimeout(
        T.create(Object.assign({}, PAIR, (opts && opts.pair) || {})).then((v) => ({ v })),
        createMs,
        null
      );
      if (!made) {
        return { ok: false, reason: 'timeout', stage: 'create', msCreate: Date.now() - t0, ms: Date.now() - t0 };
      }
      tr = made.v;
    } catch (e) {
      return {
        ok: false,
        reason: 'create-failed',
        error: String((e && e.message) || e),
        msCreate: Date.now() - t0,
        ms: Date.now() - t0,
      };
    }
    const msCreate = Date.now() - t0;
    try {
      const out = await withTimeout(tr.translate(body), translateMs, null);
      if (out === null) {
        return { ok: false, reason: 'timeout', stage: 'translate', msCreate, ms: Date.now() - t0 };
      }
      return { ok: true, text: String(out), msCreate, ms: Date.now() - t0 };
    } catch (e) {
      return {
        ok: false,
        reason: 'translate-failed',
        error: String((e && e.message) || e),
        msCreate,
        ms: Date.now() - t0,
      };
    }
  }

  // ── 能力缓存(装机门禁要**同步**答案,所以缓存一次异步读数)──────────
  let capState = 'unknown';
  let capReading = false;
  const capListeners = new Set();

  function translateCap() {
    if (capState === 'unknown' && !capReading) {
      capReading = true;
      availabilityOf()
        .then((v) => {
          capState = v === 'available' || v === 'downloadable' ? 'ok' : 'no';
          for (const fn of Array.from(capListeners)) {
            try {
              fn(capState);
            } catch {
              /* 通知失败不影响读数 */
            }
          }
          capListeners.clear();
        })
        .catch(() => {
          capState = 'no';
        });
    }
    return capState;
  }

  function onTranslateCap(fn) {
    if (typeof fn === 'function') capListeners.add(fn);
    return () => capListeners.delete(fn);
  }

  function _resetTranslateCap() {
    capState = 'unknown';
    capReading = false;
    capListeners.clear();
  }

  return {
    availabilityOf,
    translateText,
    PAIR,
    /**
     * 同步的能力读数(供按钮装机门禁用):'unknown' | 'ok' | 'no'。
     * 第一次调用会**顺带触发一次**异步读数;读完后用 onTranslateCap 通知重试装机。
     * 'ok' = available 或 downloadable —— downloadable 也算:点击手势里 create
     * 会自己触发下载,按钮上如实显示「翻译中…」就是下载的反馈。
     */
    translateCap,
    onTranslateCap,
    /** 测试用:每份文档的能力缓存不该跨用例泄漏 */
    _resetTranslateCap,
  };
});
