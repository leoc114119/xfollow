// MAIN world 注入。这个文件是整个工具的安全底座。
//
// 它做的唯一一件事:被动监听 X 自己的应用发出的请求,把**已经返回**的响应体顺手读一份。
// 它自己不发任何请求、不碰凭证、不改请求头。
//
// 为什么必须这么做 —— 上一轮实测(见 README):
//   直接调 x.com/i/api 大约 5-6 次后,网关开始对**所有**路径返回 403 空 body,
//   连应用自己在用的端点也一样;而正常浏览完全不受影响。
//   最可能的原因是应用每次都带 x-client-transaction-id 签名,脚本请求没有。
//
// 两个踩过的坑,这一版都修掉了:
//   1. XHR 实例会被复用。旧版 open 时不清状态、send 时每次都挂一个永久 load 监听,
//      于是先请求 Following、再请求别的接口时,后者的响应会贴着前者留下的 URL 发出去,
//      而且可能发多次 —— 非列表响应被当成列表。
//   2. 旧版 emit 遇到空 body 直接返回。而"403 + 空 body"正是限流的标准特征,
//      等于把最重要的安全信号丢掉了。现在空 body 也会上报状态,交给 guard 判定。
//
// 它还顺带记录**见过的所有 GraphQL 操作名**。如果关注列表不是走我们预期的操作名,
// 这份清单就是唯一能证明它的东西 —— 不用再猜。
(function () {
  if (window.__xfTapInstalled) return;
  window.__xfTapInstalled = true;

  const CHANNEL = '__xf_payload__';
  const OPS_CHANNEL = '__xf_ops__';
  const NAV_CHANNEL = '__xf_nav__';
  const MAX_BODY = 12 * 1024 * 1024;

  // 精确匹配,不用宽泛的子串。
  // 用 /Following/ 这种子串匹配会误伤时间线接口(HomeTimeline 里也有 user 对象),
  // 一旦误收就会污染名单。GraphQL 的操作名是路径最后一段,所以按白名单比对最后一段。
  const LIST_OPS = new Set([
    'Following',
    'Followers',
    'FollowingLight',
    'FollowersLight',
    'VerifiedFollowers',
    'BlueVerifiedFollowers',
    'UserFollowing',
    'UserFollowers',
  ]);
  const LIST_11 = /\/1\.1\/(friends|followers)\/list\.json$/i;
  // 关注 / 取关。这两个**不是**我们要采集的名单,但它们的响应里有"目标是谁" ——
  // 页面自己发这两个请求的唯一时机,就是用户在 X 界面上点了关注或取关。
  // 顺手读一下,名单就能立刻反映真实状态:你点完回来,那一行自己就消失了。
  // 这不新增任何请求,也不代替你点击 —— 只是把你已经做过的事记下来。
  const WRITE_11 = /\/1\.1\/friendships\/(create|destroy)\.json$/i;

  const observedOps = new Set();
  let opsSent = '';

  function pathOf(url) {
    try {
      return new URL(String(url), location.origin).pathname;
    } catch {
      return null;
    }
  }

  function opNameOf(url) {
    const p = pathOf(url);
    if (!p) return null;
    const segs = p.split('/').filter(Boolean);
    if (segs[0] !== 'i' || segs[1] !== 'api' || segs[2] !== 'graphql') return null;
    return segs[segs.length - 1] || null;
  }

  function classify(url) {
    const p = pathOf(url);
    if (!p) return null;
    const w = WRITE_11.exec(p);
    if (w) return w[1].toLowerCase() === 'create' ? 'follow' : 'unfollow';
    if (LIST_11.test(p)) return /friends/i.test(p) ? 'following' : 'followers';
    const op = opNameOf(url);
    if (op && LIST_OPS.has(op)) {
      return /Followers/i.test(op) && !/Following/i.test(op) ? 'followers' : 'following';
    }
    return null;
  }

  function post(msg) {
    try {
      window.postMessage(msg, location.origin);
    } catch {
      /* ignore */
    }
  }

  /** 记下见过的操作名。变了就立刻推一份出去,方便定位"列表到底走哪个操作名"。 */
  function noteOp(url) {
    const op = opNameOf(url);
    if (!op || observedOps.has(op)) return;
    observedOps.add(op);
    const list = Array.from(observedOps).slice(-60);
    const key = list.join(',');
    if (key === opsSent) return;
    opsSent = key;
    post({ [OPS_CHANNEL]: 1, ops: list });
  }

  /**
   * 上报一次响应。
   * status 一定会带上 —— 空 body + 403 是限流信号,不能因为 body 为空就丢掉。
   */
  function emit(url, status, body, listType) {
    const text = typeof body === 'string' ? body : '';
    if (text.length > MAX_BODY) return;
    post({ [CHANNEL]: 1, url: String(url), status, body: text, listType });
  }

  /**
   * 只上报状态码,不带 body。
   * 用于**未分类**的请求:我们不需要它们的内容,但任何 X 接口返回 4xx/5xx 都是
   * 限流/封堵的潜在信号,值得让 guard 看到。带着 body 会上报太多无关数据。
   */
  function emitStatusOnly(url, status) {
    post({ [CHANNEL]: 1, url: String(url), status, body: '', listType: null });
  }

  // ── 主路径:XMLHttpRequest ─────────────────────────────────
  // X 的前端用 XHR 而不是 fetch(上一轮实测:抓到的接口 URL 全带 xhr 前缀,
  // 没有一个是 fetch)。只 patch fetch 的控制台脚本会一条都抓不到。
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      noteOp(url);
      const lt = classify(url);
      // 每次 open 都重建请求状态。实例会被复用,不清就会张冠李戴。
      this.__xfGen = (this.__xfGen || 0) + 1;
      this.__xfMethod = String(method || 'GET').toUpperCase();
      this.__xfReq = lt
        ? { url: String(url), listType: lt, gen: this.__xfGen }
        : { url: String(url), listType: null, gen: this.__xfGen };
    } catch {
      /* 不干扰页面 */
    }
    return OrigOpen.apply(this, arguments);
  };

  // 这里原来有两块代码:被动记下午页面发请求时带的 transaction-id 签名样本,
  // 以及整套请求头(给"自己发写请求"重放用)。那条路已经放弃,两块都摘掉了 ——
  // 见仓库根目录的 ARCHIVE.md。剩下的只有下面这个纯读的拦截。
  //
  // 也不再包 setRequestHeader 了 —— 没有读者。要加回来时记住:X 的应用
  // 是带着自己算的签名发请求的,这个钩子是唯一能被动拿到它的地方。

  XMLHttpRequest.prototype.send = function () {
    const req = this.__xfReq;
    if (!req) return OrigSend.apply(this, arguments);
    const gen = req.gen;
    const xhr = this;
    // 用 loadend:load / error / abort 之后它都会触发,监听器不会残留。
    // 并且只处理还属于这次 open 的响应 —— 复用实例时旧监听器会看到 gen 不匹配。
    const handler = function () {
      xhr.removeEventListener('loadend', handler);
      if (xhr.__xfGen !== gen) return;
      const status = xhr.status;
      if (!req.listType) {
        // 未分类:只要出错就上报状态码,供熔断判定
        if (status >= 400) emitStatusOnly(req.url, status);
        return;
      }
      try {
        let text = '';
        const rt = xhr.responseType;
        if (rt === '' || rt === 'text') text = xhr.responseText;
        else if (rt === 'json') text = JSON.stringify(xhr.response);
        emit(req.url, status, text, req.listType);
      } catch {
        /* responseText 在非文本 responseType 下会抛,忽略 */
      }
    };
    this.addEventListener('loadend', handler);
    return OrigSend.apply(this, arguments);
  };

  // ── 兜底:fetch ────────────────────────────────────────────
  // 今天用不到,但 X 换实现的那天这就是"工具悄悄失效"和"工具继续工作"的区别。
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      let url = null;
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof input.url === 'string') url = input.url;

      if (url) {
        try {
          noteOp(url);
        } catch {
          /* ignore */
        }
      }
      const lt = url ? classify(url) : null;
      const p = origFetch.apply(this, arguments);
      if (lt) {
        p.then((res) => {
          try {
            // clone 是必须的:原始 body 只能被读一次,直接读会把页面自己的代码饿死
            res
              .clone()
              .text()
              .then((t) => emit(url, res.status, t, lt))
              .catch(() => {});
          } catch {
            /* ignore */
          }
        }).catch(() => {});
      }
      return p;
    };
  }

  // ── 路由变化通知 ──────────────────────────────────────────
  // X 是单页应用:点链接不会重新加载页面,扩展的 content script 也就不会被重新注入。
  // 之前只靠在隔离世界里每 1.5 秒比对一次 location.pathname,漏一次就彻底不再补 ——
  // 表现就是"右下角的面板有时不出现,刷新一下才出来"。
  function emitNav() {
    post({ [NAV_CHANNEL]: 1, url: location.href });
  }

  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    if (typeof orig === 'function') {
      history[m] = function () {
        const r = orig.apply(this, arguments);
        emitNav();
        return r;
      };
    }
  }
  window.addEventListener('popstate', emitNav, false);
  window.addEventListener('hashchange', emitNav, false);
})();
