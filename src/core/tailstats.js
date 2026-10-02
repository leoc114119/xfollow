// 「今天带尾巴发出去了几条」的计数逻辑。
//
// 抽成纯函数的原因:落盘必须由 **service worker 一个人**做(多个内容脚本各自读改写会丢增量 ——
// 这个项目在配额上踩过同一个 TOCTOU),但逻辑藏在 SW 里就测不到 ⇒ 逻辑在这里、IO 在 SW 里。
//
// 口径(按外部评审修正,评审文件 ~/Documents/xxx/TAIL-LEDGER-REVIEW.md):
//   · 只在**创建成功的响应**上计数 —— 请求发了不算(网络失败、403/429、业务错误、草稿还在编辑器里都算"没发出去")
//   · 去重键是 **(账号, 新帖 id)** —— "日期→数字"那种形状回答不了"这个帖子算过没有"
//   · 记的是**事件发生的那一天**,不是渲染那一刻(面板开着过午夜、事件晚到,都不该归错天)
//   · 一天的数字由确认事件算出来;同一帖里出现两条尾巴也只算一次
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATS_KEY = 'xf:tailStats';
  const SEEN_KEY = 'xf:tailSeen';
  const KEEP_DAYS = 30;

  /** 本机日期键(你的一天就是本机的一天) */
  function dayKeyOf(ts) {
    const d = new Date(typeof ts === 'number' ? ts : Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function seenKeyOf(event) {
    const actor = String((event && event.actorId) || '').trim();
    const post = String((event && event.postId) || '').trim();
    if (!actor || !post) return ''; // 缺一个就没法可靠去重 ⇒ 不收(宁可少算,不可重复算)
    return actor + ':' + post;
  }

  /**
   * 记一条确认事件。返回 {stats, seen, counted, reason}
   *   counted=true  ⇒ 这一条是新的,数字 +1
   *   counted=false ⇒ reason 说明为什么没算(重复/缺 id/时间不对)
   * **不修改入参**(纯函数):调用方拿到新对象再落盘。
   */
  function bump(state, event, now) {
    const stats = Object.assign({}, (state && state.stats) || {});
    const seen = Object.assign({}, (state && state.seen) || {});
    const at = event && typeof event.at === 'number' && event.at > 0 ? event.at : now || Date.now();
    const key = seenKeyOf(event);
    if (!key) return { stats, seen, counted: false, reason: 'missing-id' };
    if (seen[key]) return { stats, seen, counted: false, reason: 'already-counted' };
    seen[key] = at;
    const day = dayKeyOf(at); // **事件日**
    stats[day] = (stats[day] || 0) + 1;
    return { stats, seen, counted: true, reason: 'counted', day };
  }

  /** 裁掉 KEEP_DAYS 之外的:天数键与去重表一起裁,别无限涨 */
  function prune(state, now) {
    const cutoff = (now || Date.now()) - KEEP_DAYS * 86400000;
    const stats = {};
    const seen = {};
    const s = (state && state.stats) || {};
    for (const day of Object.keys(s)) {
      // "2026-09-27" 当天 0 点的时间戳
      const t = new Date(day + 'T00:00:00').getTime();
      if (!isNaN(t) && t >= cutoff) stats[day] = s[day];
    }
    const sn = (state && state.seen) || {};
    for (const k of Object.keys(sn)) {
      if (typeof sn[k] === 'number' && sn[k] >= cutoff) seen[k] = sn[k];
    }
    return { stats, seen };
  }

  /** 给界面用:今天几条 */
  function today(state, now) {
    const s = (state && state.stats) || {};
    return s[dayKeyOf(now)] || 0;
  }

  return { dayKeyOf, seenKeyOf, bump, prune, today, STATS_KEY, SEEN_KEY, KEEP_DAYS };
});
