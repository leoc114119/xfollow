// 帖子右上角的「未关注」角标。
//
// 位置:作者名那一行的右上角 —— 时间戳右边、`⋯` 菜单左边(用户指的就是那儿)。
//
// ── 五条不能破的规矩(外部两份方案独立给出一致的结论) ──────────
// 1. **未知一律沉默。** 只有"明确读到 iFollow===false"才显示。读不到、字段缺失、
//    身份对不上 —— 全都不显示。绝不把"未知"画成"未关注":
//    (真机踩过:同一操作名的一份响应里关系字段全为 0,另一份有 43 个。
//     所以"没读到"绝不能被当成"没关注"。)
// 2. **只是标记,不可点。** 点一下就去关注 = 把弱判断变成写动作入口,还会和 X 的 `⋯` 抢区域。
//    要可点只能走现有执行器(`xf:job` 通道),不在这里另开一条。
// 3. **不改 X 的任何东西**:不换它的节点、不改它的语义/aria/href、不覆盖它的样式、
//    不劫持它的点击。我们只往它的容器里**新增**一个自己的 span。
// 4. **数据只来自独立命名空间**(`xf:authorfacts`),绝不读也不写账本的关系观测。
//    唯一例外是**只读**账本做一次裁决:用户刚在我们侧栏点过关注,账本会比页面上的
//    响应新,那时必须以账本为准(否则用户会看到自己刚关注的人还挂着"未关注")。
// 5. **虚拟列表会回收节点。** 所以去重键是"作者",不是"标过没"这个布尔量 ——
//    同一个 article 可能被复用成别人的帖子。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FACTS_KEY = 'xf:authorfacts';
  const CLS = 'xf-uw';
  const MARK_FOR = 'data-xf-uw-for'; // 上次处理时这条帖子的作者键
  const STYLE_ID = 'xf-badge-style';
  const PER_FRAME = 25; // 每帧最多处理多少条候选
  const BUDGET_MS = 4; // 每帧时间预算,超了就留给下一帧

  let store = null; // 落盘的原样:{ handle, byId: { [id]: {f,fb,bv,sn,at} } }
  let bySn = {}; // 内存派生索引:handle(小写) -> fact(带 id)。不落盘,避免两份索引不一致
  let state = null; // 账本状态(只读,用于裁决)
  let obs = null;
  let raf = false;
  let started = false;

  const ns = () => (typeof globalThis !== 'undefined' && globalThis.XF) || {};

  // ── 作者身份 ────────────────────────────────────────────────
  /**
   * 从帖子里读出作者 handle。
   * 只看 `User-Name` 组里的 `/<handle>` 链接 —— 那条是作者本人;
   * 帖子正文里的其它链接(`/x/status/...`、话题、媒体)都不算。
   */
  function authorKeyOf(article) {
    let box = null;
    try {
      box = article.querySelector('[data-testid="User-Name"]');
    } catch {
      /* 选择器不支持就放弃这一条 */
    }
    if (!box) return '';
    for (const a of box.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      const m = h.match(/^\/([A-Za-z0-9_]{1,20})$/);
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  /** 嵌套在别的帖子里的(引用帖)不动 —— 免得把外层作者的关系安到它头上 */
  function isNested(article) {
    const p = article.parentElement;
    return !!(p && p.closest && p.closest('article[data-testid="tweet"]'));
  }

  /** 建立 handle → fact 的索引。只在这里派生,落盘的那份永远只有 byId。 */
  function setStore(next) {
    store = next || null;
    bySn = {};
    if (!store || !store.byId) return;
    for (const id of Object.keys(store.byId)) {
      const f = store.byId[id];
      if (f && f.sn) bySn[String(f.sn).toLowerCase()] = Object.assign({ id }, f);
    }
  }

  /**
   * 页面到底是深色还是浅色 —— 读**页面实际底色**,不看系统偏好。
   *
   * 为什么不共用 sidebar.js 里那个 detectTheme:它是私有的,而角标为了读一次底色
   * 不该依赖抽屉挂载。
   * 为什么不能只用 prefers-color-scheme:X 的外观默认是"跟随系统",但它是个**独立设置** ——
   * 系统浅色 + X 深色时会拿深红去压黑底(实测对比度 2.8:1,12px 小字不合格)。
   */
  function pageTheme() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      let bg = '';
      try {
        bg = getComputedStyle(el).backgroundColor || '';
      } catch {
        bg = '';
      }
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const parts = m[1].split(',').map((x) => parseFloat(x));
      if (parts.length < 3 || parts.some((x) => isNaN(x))) continue;
      if (parts.length > 3 && parts[3] === 0) continue; // 全透明不算数,那是瞎猜
      const lum = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
      return lum > 0.5 ? 'light' : 'dark';
    }
    try {
      // 读不出来就退回系统偏好
      return typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } catch {
      return 'light';
    }
  }

  function factFor(key) {
    if (!key) return null;
    return bySn[String(key).toLowerCase()] || null;
  }

  /** 账本里有没有一条**更新**的观测说"我关注了他" */
  function ledgerOverrides(fact) {
    if (!state || !state.relations) return false;
    const row = state.relations[fact.id || ''];
    const o = row && row.obs && row.obs.iFollow;
    if (!o) return false;
    let newest = null;
    for (const src of Object.keys(o)) {
      const v = o[src];
      if (v && typeof v.at === 'number' && (!newest || v.at > newest.at)) newest = v;
    }
    return !!(newest && newest.v === true && newest.at > (fact.at || 0));
  }

  /**
   * 显示裁决 —— 纯函数,可单测。返回要显示的文字,或 '' 表示不显示。
   * 顺序即优先级:任何一条不满足就沉默。
   */
  function verdictFor(key) {
    const f = factFor(key);
    if (!f) return ''; // 没有事实
    if (f.f !== false) return ''; // 不是"明确未关注"
    if (f.id && state && state.whitelist && state.whitelist[f.id]) return ''; // 忽略过的人不标
    if (ledgerOverrides(f)) return ''; // 账本里有更新的"已关注"
    return '未关注';
  }

  /** 悬停提示:主标只写"未关注",其余信息放这儿(用户定的) */
  function titleFor(key) {
    const f = factFor(key);
    if (!f) return '';
    const bits = ['你没有关注他'];
    if (f.bv === true) bits.push('蓝V');
    if (f.fb === true) bits.push('他关注了你');
    const row = state && state.relations && state.relations[f.id || ''];
    if (row && row.heStoppedAt) bits.push('曾观测到取关');
    return bits.join(' · ');
  }

  // ── 注入 ────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // 用 textContent 而不是内联 style 属性:后者的等价值写法会被一部分 CSP 拦掉,
    // 表现是"东西插进去了但没有样式"(这是这个仓库在侧边栏上踩过的坑)。
    // 「印章」观感:红框红字、方一点的圆角、不加底色。
    // 原来是灰底灰字的胶囊 —— 在 X 的头部行里几乎看不见(用户原话"不够明显")。
    // 只声明一次颜色:`border` 用 currentColor,所以红框红字由一个色值驱动。
    style.textContent = [
      '.xf-uw{flex:none;margin-right:8px;padding:1px 6px;border-radius:4px;',
      '  border:1px solid currentColor;',
      '  font:700 12px/16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      '  letter-spacing:.5px;color:#c8102e;background:transparent;',
      '  pointer-events:none;user-select:none;white-space:nowrap;max-width:72px;',
      '  overflow:hidden;text-overflow:ellipsis}',
      // 深色页面用更亮的红:深红压黑底实测只有 2.8:1,12px 小字不合格。
      // 用属性而不是媒体查询 —— 主题由 pageTheme() 读**页面底色**决定,不是系统偏好。
      '.xf-uw[data-xf-t="dark"]{color:#ff6b81}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /** 处理一条帖子:该显示的插上,该消失的摘掉,都不该做就不留痕迹 */
  function applyTo(article, theme) {
    if (isNested(article)) return;
    const key = authorKeyOf(article);
    if (!key) return;
    const want = verdictFor(key);
    const have = article.querySelector('.' + CLS);
    if (!want) {
      if (have) have.remove();
      article.setAttribute(MARK_FOR, key);
      return;
    }
    if (have && article.getAttribute(MARK_FOR) === key) {
      // 已就位。但主题可能被用户改了 —— 顺手同步,免得旧色一直留在那儿。
      if (theme && have.getAttribute('data-xf-t') !== theme) have.setAttribute('data-xf-t', theme);
      return;
    }
    if (have) have.remove();
    // 落点:`⋯` 按钮左边。这是用户指的位置(时间戳右边、菜单左边),
    // 而且它一定在头部那一行里,不用去猜 X 的布局层级。
    let caret = null;
    try {
      caret = article.querySelector('[data-testid="caret"]');
    } catch {
      /* ignore */
    }
    if (!caret || !caret.parentElement) return; // 结构不认识就什么都不做,绝不往别处硬塞
    const span = document.createElement('span');
    span.className = CLS;
    span.textContent = want;
    span.title = titleFor(key);
    span.setAttribute('data-xf-t', theme || pageTheme());
    caret.parentElement.insertBefore(span, caret);
    article.setAttribute(MARK_FOR, key);
  }

  function sweep() {
    if (!store || document.hidden) return;
    ensureStyle();
    const theme = pageTheme(); // 每轮读一次,别每条帖子都读
    let n = 0;
    const t0 = Date.now();
    let arts;
    try {
      arts = document.querySelectorAll('article[data-testid="tweet"]');
    } catch {
      return;
    }
    for (const a of arts) {
      if (n >= PER_FRAME || Date.now() - t0 > BUDGET_MS) {
        schedule(); // 没做完就下一帧接着做,不阻塞滚动
        break;
      }
      n += 1;
      applyTo(a, theme);
    }
  }

  /** 观察器回调只做这一件事:回调 O(1),高频 mutation 也不怕 */
  function schedule() {
    if (raf) return;
    raf = true;
    const rafFn =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);
    rafFn(() => {
      raf = false;
      sweep();
    });
  }

  async function refresh() {
    const load = ns().loadState;
    const get = (keys) =>
      new Promise((res) => {
        try {
          chrome.storage.local.get(keys, (r) => res(r || {}));
        } catch {
          res({});
        }
      });
    const got = await get([FACTS_KEY]);
    setStore(got[FACTS_KEY] || null);
    if (load) {
      try {
        state = await load();
      } catch {
        state = null;
      }
    }
    schedule();
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    // 观察范围尽量窄:首选时间线容器,拿不到才退到 body
    let target = null;
    try {
      target = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    } catch {
      target = document.body;
    }
    if (target && typeof MutationObserver === 'function') {
      obs = new MutationObserver(schedule); // 回调里只有 schedule,别在这里做任何查询
      obs.observe(target, { childList: true, subtree: true });
    }
    // 我们自己的写操作会改存储;被动响应(create/destroy)也会 —— 都要重算一次
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[FACTS_KEY] || changes['xf:relations'] || changes['xf:whitelist']) refresh();
      });
    } catch {
      /* ignore */
    }
  }

  function stop() {
    if (obs) obs.disconnect();
    obs = null;
    started = false;
    for (const el of document.querySelectorAll('.' + CLS)) el.remove();
  }

  // 和 sidebar 一样自己起:没有别人会来调 start()。
  // (node 里 require 它时 `document` 不存在,所以测试不会被这行带起来。)
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return {
    start,
    stop,
    // 给测试用的纯函数入口
    _verdictFor: verdictFor,
    _authorKeyOf: authorKeyOf,
    _setFacts: (f, s) => {
      setStore(f);
      state = s;
    },
    _applyTo: applyTo,
    _sweep: sweep,
  };
});
