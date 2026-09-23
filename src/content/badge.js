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
  const STYLE_ID = 'xf-badge-style';
  const PER_FRAME = 25; // 每帧最多**处理**多少条(已就位的不占这个额度,见 sweep)
  const BUDGET_MS = 4; // 每帧时间预算,超了就留给下一帧
  // 负事实的有效期:过期按未知处理。
  // 为什么需要(外部审查指出):用户在**手机或别的浏览器**上关注了某人时,本扩展看不到
  // 那条动作,旧事实会一直说"你没关注他"。有效期只能降低这种误报,做不到实时同步 ——
  // 所以文案不宣称"当前",只保证是"近期观察到的"。
  const FRESH_MS = 6 * 60 * 60 * 1000;

  let store = null; // 落盘的原样:{ handle, byId: { [id]: {f,fb,bv,sn,at} } }
  let bySn = {}; // 内存派生索引:handle(小写) -> fact(带 id)。不落盘,避免两份索引不一致
  let state = null; // 账本状态(只读)。**null = 读不到 → 一律沉默**(fail closed)
  let obs = null;
  let obsTarget = null;
  let raf = false;
  let started = false;
  let cursor = 0; // 跨帧游标:上一帧扫到哪了。列表变化/切前台时归零
  let onChanged = null; // 存引用:stop() 要能摘掉它,否则反复启停会越积越多
  // article -> { key, node|null }:这条帖子处理过谁、我们插了哪个节点。
  // **用 WeakMap 而不是往 X 的节点上写属性** —— 不变式 3 是"只新增自己的 span"。
  const seen = new WeakMap();

  const ns = () => (typeof globalThis !== 'undefined' && globalThis.XF) || {};

  /**
   * 当前登录账号的 handle。拿不到就是空 —— **空即未知,未知不显示**。
   * 为什么必须比:缓存里可能装着**上一个账号**的负事实,拿它给新账号打标就是误标。
   */
  function currentHandle() {
    const B = ns();
    if (!B || typeof B.identity !== 'function') return '';
    try {
      return (B.identity() || {}).handle || '';
    } catch {
      return '';
    }
  }

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
    const dup = new Set();
    for (const id of Object.keys(store.byId)) {
      const f = store.byId[id];
      // **必须有合法数字 id**:handle 会改名、会被重新占用,身份不稳的事实不敢用
      if (!f || !f.sn || !/^\d+$/.test(String(id))) continue;
      const k = String(f.sn).toLowerCase();
      // 同一个 handle 对上两个 id = 有歧义 → 两个都不用(归为未知,不是"未关注")。
      // 不这么做的话,Object.keys 的顺序就会决定给谁打标。
      if (bySn[k]) {
        dup.add(k);
        continue;
      }
      bySn[k] = Object.assign({ id: String(id) }, f);
    }
    for (const k of dup) delete bySn[k];
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
    // 同时刻也算账本胜:两边都是 Date.now() 毫秒,同毫秒不是不可能,
    // 而一条可信的 true 不该被等时的 false 压掉。
    return !!(newest && newest.v === true && newest.at >= (fact.at || 0));
  }

  /**
   * 显示裁决 —— 纯函数,可单测。返回要显示的文字,或 '' 表示不显示。
   * 顺序即优先级:任何一条不满足就沉默。
   */
  function verdictFor(key) {
    const me = currentHandle();
    // 账号对不上(或身份未知)就沉默:缓存可能属于上一个账号
    if (!me || !store || !store.handle || store.handle !== me) return '';
    // 账本读不到 → 白名单和"刚在我们这儿关注过"都无从判断,宁可少标
    if (!state) return '';
    const f = factFor(key);
    if (!f) return ''; // 没有事实
    if (f.f !== false) return ''; // 不是"明确未关注"
    if (!f.id || !/^\d+$/.test(String(f.id))) return ''; // 身份不稳,不判
    if (!f.at || Date.now() - f.at > FRESH_MS) return ''; // 过期即沉默
    if (state.whitelist && state.whitelist[f.id]) return ''; // 忽略过的人不标
    if (ledgerOverrides(f)) return ''; // 账本里有不比它旧的"已关注"
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
  /** 把我们自己的节点摘掉,并清掉记忆。**只碰我们自己的东西。** */
  function dropOwn(article) {
    const p = seen.get(article);
    if (p && p.node && p.node.parentNode) p.node.remove();
    seen.delete(article);
  }

  /**
   * 处理一条帖子:该显示的插上,该消失的摘掉。
   *
   * **读不到作者、结构不认识、该沉默的 —— 都必须先把旧角标摘掉再返回。**
   * 虚拟列表会把同一个 article 复用成别人的帖子,让旧结论留在新内容上就是误标
   * (外部审查抓到的路径:React 分阶段重绘时 User-Name 会先被删掉再插新的)。
   */
  function applyTo(article, theme) {
    if (isNested(article)) {
      dropOwn(article);
      return;
    }
    const key = authorKeyOf(article);
    if (!key) {
      dropOwn(article); // 作者一时读不到 → 摘掉旧的,绝不留错标
      return;
    }
    const prev = seen.get(article);
    const want = verdictFor(key);
    if (!want) {
      dropOwn(article);
      seen.set(article, { key, node: null }); // 记下"处理过了",别每帧重算
      return;
    }
    if (prev && prev.key === key && prev.node && prev.node.parentNode) {
      // 已就位。但主题可能被用户改了 —— 顺手同步,免得旧色一直留在那儿。
      if (theme && prev.node.getAttribute('data-xf-t') !== theme) {
        prev.node.setAttribute('data-xf-t', theme);
      }
      return;
    }
    dropOwn(article);
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
    seen.set(article, { key, node: span });
  }

  function sweep() {
    if (!store || document.hidden) return;
    ensureStyle();
    const theme = pageTheme(); // 每轮读一次,别每条帖子都读
    let arts;
    try {
      arts = document.querySelectorAll('article[data-testid="tweet"]');
    } catch {
      return;
    }
    // **跨帧游标**(外部审查抓到的 bug):原来每帧都从第一条开始、前 25 条把额度用光,
    // 于是第 26 条之后**永远**处理不到 —— 而且每帧还在排队,白烧 CPU。
    // 现在从上次停下的地方接着扫,列表变化/切前台时游标归零。
    if (cursor >= arts.length) cursor = 0;
    const t0 = Date.now();
    let n = 0;
    let i = cursor;
    for (; i < arts.length; i += 1) {
      if (n >= PER_FRAME || Date.now() - t0 > BUDGET_MS) break;
      n += 1;
      applyTo(arts[i], theme);
    }
    cursor = i;
    if (i < arts.length) schedule(); // 没走完,下一帧接着
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
    cursor = 0; // 数据变了,从头重扫
    attach();
    schedule();
  }

  /**
   * 挂/重挂观察器。
   * **目标会被 React 整块换掉**(SPA 导航时 primaryColumn 可能被替换),
   * 那时旧观察器就留在脱离页面的节点上、再也收不到 mutation —— 表现是"角标不再更新"。
   * 所以每次 refresh 和每轮扫描前都检查一次:目标换了就重挂。
   */
  function attach() {
    // 观察范围尽量窄:首选时间线容器,拿不到才退到 body
    let target = null;
    try {
      target = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    } catch {
      target = document.body;
    }
    if (!target || typeof MutationObserver !== 'function') return;
    if (obs && obsTarget === target && target.isConnected !== false) return;
    if (obs) obs.disconnect();
    obs = new MutationObserver(schedule); // 回调里只有 schedule,别在这里做任何查询
    obs.observe(target, { childList: true, subtree: true });
    obsTarget = target;
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    attach();
    // 从后台切回前台要重扫一次:隐藏期间有意什么都不做,那期间的变化就欠着
    try {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          cursor = 0;
          schedule();
        }
      });
    } catch {
      /* ignore */
    }
    // 目标被换掉之后,至少导航时再检查一次观察器还在不在
    try {
      window.addEventListener('popstate', attach);
    } catch {
      /* ignore */
    }
    // 我们自己的写操作会改存储;被动响应(create/destroy)也会 —— 都要重算一次
    onChanged = (changes) => {
      if (changes[FACTS_KEY] || changes['xf:relations'] || changes['xf:whitelist']) refresh();
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      /* ignore */
    }
  }

  function stop() {
    if (obs) obs.disconnect();
    obs = null;
    obsTarget = null;
    // 监听也要摘掉 —— 只 disconnect 观察器是不够的(外部审查点名的"死代码陷阱")
    if (onChanged) {
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        /* ignore */
      }
      onChanged = null;
    }
    started = false;
    for (const el of document.querySelectorAll('.' + CLS)) el.remove();
  }

  // 和 sidebar 一样自己起:没有别人会来调 start()。
  // (node 里 require 它时 `document` 不存在,所以测试不会被这行带起来。)
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  /** 供界面读的健康信号:现在手上有多少位作者的关系事实。
   *  没有它,"这页没人需要标"和"数据通道死了"在界面上长得一模一样。 */
  function stats() {
    return { facts: Object.keys(bySn).length, account: store ? store.handle || '' : '' };
  }

  return {
    start,
    stop,
    badgeStats: stats,
    // 给测试用的纯函数入口
    _verdictFor: verdictFor,
    _authorKeyOf: authorKeyOf,
    _setFacts: (f, s) => {
      setStore(f);
      state = s;
    },
    _titleFor: titleFor,
    _applyTo: applyTo,
    _sweep: sweep,
    _perFrame: PER_FRAME,
    _freshMs: FRESH_MS,
  };
});
