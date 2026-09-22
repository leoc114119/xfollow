// 通用小工具。UMD 写法:content script 里挂到 XF 命名空间,node 里走 module.exports,
// 这样核心逻辑可以直接用 node --test 跑单测,不需要构建步骤。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEBUG = false;

  function log(...args) {
    if (DEBUG) console.log('[xf]', ...args);
  }

  function nowTs() {
    return Date.now();
  }

  // 本地日期键 YYYY-MM-DD。日配额按本地自然日重置,用 UTC 会让配额在下午突然刷新。
  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 把秒级间隔变成"人手的节奏":在区间内随机,不是固定值。
  // 固定间隔是最容易被识别的机器信号之一。
  function humanDelay(minSec, maxSec) {
    return sleep(randInt(Math.round(minSec * 1000), Math.round(maxSec * 1000)));
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  // 简单串行锁:content script 和 popup 都可能读改写同一份 storage,
  // 读-改-写之间必须有互斥,否则两边同时写会丢数据。
  function makeQueue() {
    let tail = Promise.resolve();
    return function enqueue(fn) {
      const run = tail.then(fn, fn);
      tail = run.catch(() => {});
      return run;
    };
  }

  /**
   * 内容脚本的上下文还活着吗。
   *
   * 扩展被重新加载/更新之后,**已经打开的标签页里那份旧内容脚本会成为孤儿** ——
   * 它的定时器和监听器还在跑,但 chrome.* 通道已经断,任何调用都抛
   * "Extension context invalidated"。刷新扩展时看到的那串报错就是这个。
   *
   * 判断方式:上下文失效后 chrome.runtime.id 会变成 undefined。
   * 所有 chrome.* 调用前都该先问一句,死了就安静地什么都不做。
   */
  function chromeAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  return { log, nowTs, dayKey, sleep, randInt, humanDelay, clamp, daysBetween, makeQueue, chromeAlive, DEBUG };
});
