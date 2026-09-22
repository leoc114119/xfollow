// 隔离世界的中转站:接住 tap.js 转过来的原始响应,解析成用户条目,累积到缓冲区。
//
// 工具要处理**两张列表**,它们提供的是不同的事实:
//   我的关注列表(我关注的人)→ 每条的 followed_by 告诉我"他回关我了吗"
//   我的粉丝列表(关注我的人)→ 每条的 following   告诉我"我回关他了吗"
// 所以两张列表各有一份独立缓冲、独立归属校验、独立代次。
//
// 这一层承担五件不能出错的事:
//   1. **所有 X 接口的限流信号都要能熔断。** 不只列表接口 ——
//      实测里最先 403 的恰恰是时间线之类的非列表接口,那个前兆信号必须接住。
//   2. **只收自己的名单。** 用响应里的列表主人身份做校验。URL 兜底认出来的"我是谁"
//      **不算验证** —— 那可能把别人当成自己,污染后还能让你误取关真实关注的人。
//   3. **只收列表条目。** 推荐模块里的用户由 extract 归到 Tier B,只计数不入名单。
//   4. **缓冲按代次管理。** 每次页面加载/切到列表页 = 新一代,清空重来。
//      否则重扫会带着上一轮累积的旧名单,"谁消失了"永远发现不了。
//   5. **两张列表不互相污染。** 各自的基线、截断状态、主人。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BUFFER_KEY = 'xf:buffer';

  /** 上下文是否还活着(扩展被重载后旧脚本会成为孤儿) */
  function chromeAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }
  const BUFFER_KEY_FOLLOWERS = 'xf:buffer:followers';

  const KEY_OF = (listType) => (listType === 'followers' ? BUFFER_KEY_FOLLOWERS : BUFFER_KEY);

  function freshState(listType) {
    return {
      listType,
      owner: null,
      ownerId: null,
      ownerVerified: false,
      startedAt: 0,
      updatedAt: 0,
      // 这一代缓冲被某次扫描消费掉的时刻。非空就说明它已经"用过了",
      // 再扫必须重新加载页面拿一份干净的 —— 否则旧的累积数据会让消失的人看起来还在。
      consumedAt: null,
      pages: 0,
      flagsAvailable: false,
      suspects: 0,
      suspectNames: [],
      stats: null,
      cursors: [],
      atEnd: false,
      parseErrors: [],
      samples: [],
      rejectedPayloads: [],
      limitTripped: null,
      users: {},
      order: [],
      seenPageKeys: {},
    };
  }

  const states = { following: freshState('following'), followers: freshState('followers') };

  // 从侧边栏/导航读到的身份、或用户手动填写的,才算可信;
  // URL 兜底只用于"能不能开始扫",不算身份验证
  let selfHandle = null;
  let selfSource = null;
  let manualSelfHandle = null;
  // 候选身份(导航/账号区读出来的)—— 只作提示,等响应来确认
  let candidate = null;
  let candidateSource = null;
  // 实测确认过的身份(testid 或手动填写)
  let trustedSelf = null;
  // 候选是否已被响应里的列表主人互证
  let confirmedByOwner = false;
  // 曾经确认过的身份(跨刷新保留)。只作兜底:实时探测优先,而且一旦实时探测
  // 读到的用户名和它不同,就说明换了账号 —— 立刻清掉,不许它冒充。
  let confirmedSelf = null;
  const CONFIRMED_KEY = 'xf:selfHandleConfirmed';
  let observedOps = [];
  let flushTimer = null;
  const listeners = new Set();
  const navListeners = new Set();
  const limitListeners = new Set();

  function emit(listType) {
    const buf = getBuffer(listType);
    for (const fn of listeners) {
      try {
        fn(listType, buf);
      } catch {
        /* 监听者自己的错不该影响采集 */
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAll();
    }, 400);
  }

  function flushAll() {
    if (!chromeAlive() || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.set({
        [BUFFER_KEY]: getBuffer('following'),
        [BUFFER_KEY_FOLLOWERS]: getBuffer('followers'),
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * 把页面自己做的一次关注/取关记进关系表。
   *
   * 只认 2xx:失败的请求(点太快被挡、已经被别人拉黑之类)不能当成"我关注了他",
   * 否则名单会显示成已回关,而实际上是没关注上。
   */
  /** 从响应里找 following 这个布尔值。找不到就返回 undefined —— 不猜。 */
  function readFollowing(j) {
    const spots = [j, j && j.legacy, j && j.data, j && j.result, j && j.data && j.data.user && j.data.user.result];
    for (const o of spots) {
      if (o && typeof o.following === 'boolean') return o.following;
    }
    return undefined;
  }

  /** 最近一次"页面自己做动作"的解析结果 —— 动作确认不了时,它是唯一能说明为什么的东西 */
  let lastServerActionResult = null;

  /**
   * 记下这次写请求走的**端点**。
   *
   * 用途是发现迁移:如果 X 把 `friendships/create` 从 1.1 换到 GraphQL,
   * 我们这条被动链会突然什么都收不到,而"端点变了"是唯一能说明原因的线索。
   * 不报出来就只看到"没有回音",查不出为什么。
   */
  function endpointOf(url) {
    const u = String(url || '');
    if (/\/1\.1\/friendships\//i.test(u)) return '1.1';
    if (/\/graphql\//i.test(u)) return 'GraphQL';
    return u ? '其它' : '未知';
  }

  function recordServerAction(kind, bodyText, status, url) {
    const X = globalThis.XF;
    const ep = endpointOf(url);
    const miss = (why) => {
      lastServerActionResult = { at: Date.now(), kind, ok: false, why, endpoint: ep };
      return { added: 0, ignored: why };
    };
    if (!(status >= 200 && status < 300)) return miss('HTTP ' + status);
    let j = null;
    let user = null;
    try {
      j = JSON.parse(bodyText);
      if (j && (j.id_str || j.rest_id || j.id)) {
        user = { id: String(j.id_str || j.rest_id || j.id), sn: j.screen_name || null };
      }
    } catch {
      /* 响应不是 JSON 就不认 */
    }
    if (!user || !user.id) return miss('响应里没有目标用户 id');

    // kind 是 tap.js 按端点分好的:'follow' = friendships/create,'unfollow' = destroy
    const following = kind === 'follow';

    // ⚠ 结果必须**从响应里读出来**,不能按端点名推断。
    //
    // 踩过:原来只判 2xx 就写"我关注了他",而响应里其实带着 following 的真实值。
    // 那样一来,服务器返回了一个相反关系(或 pending)时,我们会把错的事实记进账本,
    // 而账本是名单的唯一依据 —— 错了会长久地错下去。
    const seen = readFollowing(j);
    if (typeof seen !== 'boolean') return miss('响应里没有 following 字段');
    if (seen !== following) return miss(`响应说的和操作相反(following=${seen})`);
    // 写进观测:来源标 server —— 这是页面自己的请求结果,比任何推断都硬。
    // 下一次扫列表会给出更权威的值,两者按"最新胜出"合并。
    lastServerActionResult = { at: Date.now(), kind, id: user.id, following, ok: true, endpoint: ep };
    X.applyServerAction(user.id, user.sn, following, Date.now())
      .then(() => {
        for (const fn of listeners) {
          try {
            fn(following ? 'following' : 'followers', getBuffer(following ? 'following' : 'followers'));
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {});
    return { added: 1, user, following };
  }

  function getBuffer(listType) {
    const t = listType === 'followers' ? 'followers' : 'following';
    const s = states[t];
    return {
      listType: t,
      owner: s.owner,
      ownerId: s.ownerId,
      ownerVerified: s.ownerVerified,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      consumedAt: s.consumedAt,
      pages: s.pages,
      flagsAvailable: s.flagsAvailable,
      suspects: s.suspects,
      suspectNames: s.suspectNames.slice(-8),
      stats: s.stats,
      cursors: s.cursors.slice(-8),
      atEnd: s.atEnd,
      parseErrors: s.parseErrors.slice(-5),
      samples: s.samples.slice(-6),
      observedOps: observedOps.slice(-40),
      rejectedPayloads: s.rejectedPayloads.slice(-5),
      limitTripped: s.limitTripped,
      count: Object.keys(s.users).length,
      users: s.users,
      order: s.order,
      selfHandle,
      selfSource,
    };
  }

  function count(listType) {
    return Object.keys(states[listType === 'followers' ? 'followers' : 'following'].users).length;
  }

  // 已知的应用路由 —— 用来把"你的个人资料链接"从导航链接里区分出来
  const KNOWN_ROUTES = new Set([
    'home', 'explore', 'notifications', 'messages', 'settings', 'compose',
    'search', 'i', 'tos', 'privacy', 'about', 'login', 'logout', 'signup',
    'intent', 'share', 'account', 'jobs', 'help', 'en', 'xx',
  ]);

  /**
   * 结构化地找"你自己的账号"。
   *
   * 为什么不只靠 data-testid:那张选择器是 X 单方面决定的,改一次名整条身份链就断,
   * 而身份链一断,`trusted=false`,**所有写操作被禁用** —— 工具直接变成只读。
   * 所以这里再加两条不依赖 testid 的路:导航结构、账号切换区的文本。
   */
  function handleFromSidebarTestId() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (a) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)$/);
      if (m) return m[1];
    }
    const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (btn) {
      const m = (btn.textContent || btn.innerText || '').match(/@([A-Za-z0-9_]+)/);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * 导航结构启发式:左侧导航里**唯一**那条不像应用路由的 /<handle> 链接,
   * 就是你自己的个人资料入口。先定位到装着导航的容器(含 /home 链接的那个),
   * 再在里面找 —— 这样不会把别处的用户链接误认成自己。
   */
  function handleFromNav() {
    const home = document.querySelector('a[href="/home"]');
    if (!home) return null;
    let scope = home;
    for (let i = 0; i < 6 && scope; i++) {
      if (scope.querySelectorAll && scope.querySelectorAll('a[href^="/"]').length >= 4) break;
      scope = scope.parentElement;
    }
    if (!scope || !scope.querySelectorAll) return null;
    for (const a of scope.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{2,15})\/?$/);
      if (!m) continue;
      if (KNOWN_ROUTES.has(m[1].toLowerCase())) continue;
      return m[1];
    }
    return null;
  }

  /**
   * 设置页个人资料:这是**会话派生**的证据 —— 那个页面渲染的就是当前登录账号。
   * 页面上会同时出现输入框里的用户名和一段 @用户名 文本,两处一致才认。
   * (两处独立读取一致,才不至于被页面上别处的用户名骗到。)
   */
  function handleFromSettings() {
    if (!/^\/settings\//.test(location.pathname)) return null;
    const fromText = [];
    const RE = /^@([A-Za-z0-9_]{2,15})$/;
    for (const el of document.querySelectorAll('span, div, p')) {
      if (el.children.length) continue;
      const m = (el.textContent || '').trim().match(RE);
      if (m) fromText.push(m[1]);
    }
    const fromInput = [];
    for (const el of document.querySelectorAll('input[type="text"], input:not([type])')) {
      const v = String(el.value || '').trim();
      if (/^[A-Za-z0-9_]{2,15}$/.test(v)) fromInput.push(v);
    }
    // 两处独立来源必须一致,否则不给结论
    for (const a of fromText) {
      for (const b of fromInput) {
        if (a.toLowerCase() === b.toLowerCase()) return a;
      }
    }
    return null;
  }

  /** 整页范围最后兜底:任何写着 @handle 的账号切换区文本 */
  function handleFromAccountText() {
    for (const el of document.querySelectorAll('[role="button"], button, [data-testid]')) {
      const t = (el.textContent || '').trim();
      const m = t.match(/^@([A-Za-z0-9_]{2,15})$/);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * 我是谁。
   *
   * 关键设计:**导航/账号区读出来的只是"候选",不是身份**。
   * 它们依赖 X 的 DOM 结构和路由命名,一旦 X 加一个我没列进白名单的路由,
   * 候选就会是个错的值 —— 而错误的身份比"读不到"危险得多:
   * 它会解锁写操作,还可能把别人的列表当成你自己的。
   *
   * 所以身份分成两级:
   *   可信身份(trustedSelf):testid 读到的、或用户手动确认过的 —— 可以直接用
   *   候选(candidate):导航结构/账号区文本 —— 只作提示,等 X 自己的响应来确认
   * 确认发生在 verifyOwner 里:响应里的列表主人 === 候选时,两个独立来源互证,才算验证过。
   *
   * URL 永远只是候选,永远不算身份 —— 先访问别人的列表页会把别人认成你。
   */
  function detectSelfHandle() {
    // 手动确认过的最优先(上一版设置里填过的仍然有效)
    if (manualSelfHandle) {
      selfHandle = manualSelfHandle;
      selfSource = 'manual';
      trustedSelf = manualSelfHandle;
      return selfHandle;
    }

    const viaTestId = handleFromSidebarTestId();
    if (viaTestId) {
      if (confirmedSelf && confirmedSelf.toLowerCase() !== viaTestId.toLowerCase()) {
        // 实时探测和已确认的身份不一致 → 换账号了,旧的作废
        confirmedSelf = null;
        persistConfirmed(null);
      }
      selfHandle = viaTestId;
      selfSource = 'sidebar';
      trustedSelf = viaTestId;
      return selfHandle;
    }

    // 以下都只是候选 —— 记下来,但不当作身份
    if (!candidate) {
      candidate = handleFromNav() || handleFromAccountText() || null;
      if (candidate) candidateSource = handleFromNav() ? 'nav' : 'account-text';
    }
    if (candidate) {
      selfHandle = candidate;
      selfSource = candidateSource;
      return selfHandle;
    }

    // 实时路径全失败,但曾经确认过身份 → 用它兜底(比"功能全死"好)
    if (confirmedSelf) {
      selfHandle = confirmedSelf;
      selfSource = 'confirmed';
      trustedSelf = confirmedSelf;
      return selfHandle;
    }

    // URL 兜底:只说明"这一页的列表主人",每次都重算,不缓存,也不算身份
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/(following|followers)\/?$/i);
    if (m && m[1].toLowerCase() !== 'i') {
      selfHandle = m[1];
      selfSource = 'url';
      return selfHandle;
    }
    return null;
  }

  function persistConfirmed(h) {
    try {
      if (!chromeAlive() || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({ [CONFIRMED_KEY]: h || null });
    } catch {
      /* ignore */
    }
  }

  function rememberConfirmed(h) {
    if (!h) return;
    if (confirmedSelf === h) return;
    confirmedSelf = h;
    persistConfirmed(h);
  }

  /** 身份是否经过验证:有可信来源,或"候选已与响应里的列表主人互证" */
  function isSelfVerified() {
    return !!trustedSelf || confirmedByOwner;
  }

  /**
   * 用户点「读取我的账号」:清掉缓存重新找。
   * 返回走通了哪条路 —— 界面要把过程显示出来,而不是只丢一句"没读到"。
   */
  function probeSelfHandle() {
    selfHandle = null;
    selfSource = null;
    candidate = null;
    candidateSource = null;
    trustedSelf = null;
    confirmedByOwner = false;
    const tried = [];

    const viaTestId = handleFromSidebarTestId();
    tried.push({ via: '侧边栏(testid)', got: viaTestId });
    if (viaTestId) {
      selfHandle = viaTestId;
      selfSource = 'sidebar';
      trustedSelf = viaTestId;
      rememberConfirmed(viaTestId);
      return { handle: viaTestId, source: 'sidebar', verified: true, tried, needScan: false };
    }

    const viaNav = handleFromNav();
    tried.push({ via: '左侧导航结构', got: viaNav });
    if (viaNav) {
      candidate = viaNav;
      candidateSource = 'nav';
      selfHandle = viaNav;
      selfSource = 'nav';
      return { handle: viaNav, source: 'nav', verified: false, tried, needScan: true };
    }

    const viaText = handleFromAccountText();
    tried.push({ via: '账号切换区文本', got: viaText });
    if (viaText) {
      candidate = viaText;
      candidateSource = 'account-text';
      selfHandle = viaText;
      selfSource = 'account-text';
      return { handle: viaText, source: 'account-text', verified: false, tried, needScan: true };
    }

    const viaSettings = handleFromSettings();
    tried.push({ via: '设置页个人资料', got: viaSettings });
    if (viaSettings) {
      selfHandle = viaSettings;
      selfSource = 'settings';
      trustedSelf = viaSettings;
      rememberConfirmed(viaSettings);
      return { handle: viaSettings, source: 'settings', verified: true, tried, needScan: false };
    }

    tried.push({ via: 'URL(只作交叉验证)', got: location.pathname.match(/^\/([A-Za-z0-9_]+)\//)?.[1] || null });
    return { handle: null, source: null, verified: false, tried, needScan: true };
  }

  /**
   * 手动确认身份。不是主路径(主路径是那个「读取我的账号」按钮 + 响应互证),
   * 但留作最后兜底:自动识别全失效时,总得有一条能走通的路。
   * 用户亲手写下的用户名本身就是一种验证 —— 比任何启发式都可靠。
   */
  async function setManualSelfHandle(handle) {
    const h = String(handle || '').trim().replace(/^@/, '');
    manualSelfHandle = /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
    if (manualSelfHandle) {
      selfHandle = manualSelfHandle;
      selfSource = 'manual';
      trustedSelf = manualSelfHandle;
      rememberConfirmed(manualSelfHandle);
    } else {
      selfHandle = null;
      selfSource = null;
      trustedSelf = null;
    }
    await new Promise((r) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return r();
      chrome.storage.local.set({ 'xf:selfHandle': manualSelfHandle }, () => r());
    });
    return { ok: !!manualSelfHandle, handle: manualSelfHandle };
  }

  /**
   * 开始新一代缓冲:清空并记开始时间。
   * 触发时机是页面加载、或切换到某张列表页 —— 也就是页面**即将**发出列表请求之前。
   * 这样首页会落进干净的缓冲里,而不是和上一轮的累积数据混在一起。
   */
  function newGeneration(listType, owner) {
    const t = listType === 'followers' ? 'followers' : 'following';
    states[t] = freshState(t);
    states[t].owner = owner || null;
    states[t].startedAt = Date.now();
    states[t].updatedAt = Date.now();
    flushAll();
    emit(t);
    return states[t];
  }

  /** 扫描完成之后标记这一代已被消费 —— 下次扫描必须重新加载页面。 */
  function markConsumed(listType) {
    const t = listType === 'followers' ? 'followers' : 'following';
    states[t].consumedAt = Date.now();
    flushAll();
  }

  /** 校验这包数据是不是"我的这张名单"。 */
  function verifyOwner(owner, listType) {
    const s = states[listType];

    if (!owner || !owner.id) {
      // 响应里没带主人信息(比如 1.1 的 /friends/list.json)。收下,按现有信任级别标记。
      return { ok: true, verified: isSelfVerified(), reason: '响应里没有列表主人信息' };
    }

    // 有可信身份时,才敢断言"这是别人的列表" —— 这也是防污染的关键一环
    if (trustedSelf && owner.handle && owner.handle.toLowerCase() !== trustedSelf.toLowerCase()) {
      return { ok: false, reason: `这是 @${owner.handle} 的列表,不是你的` };
    }

    // 候选 vs 响应主人:两个独立来源互证。
    // 这一条能在 testid 失效时把身份救回来 —— 一个人自己的列表页上,
    // 导航读到的用户名和响应里的列表主人必然同名。
    let verified = isSelfVerified();
    if (!verified && candidate && owner.handle && owner.handle.toLowerCase() === candidate.toLowerCase()) {
      confirmedByOwner = true;
      selfHandle = owner.handle;
      trustedSelf = owner.handle;
      rememberConfirmed(owner.handle);
      verified = true;
    }

    if (s.ownerId && owner.id !== s.ownerId) {
      return { ok: false, reason: '列表主人和这次采集的不是同一个账号' };
    }
    return { ok: true, verified: verified && !!owner.handle };
  }

  function reject(listType, reason, url) {
    const s = states[listType];
    s.rejectedPayloads.push({ ts: Date.now(), reason, url: String(url || '').slice(0, 160) });
    if (s.rejectedPayloads.length > 20) s.rejectedPayloads = s.rejectedPayloads.slice(-20);
  }

  function ingest(msg) {
    const G = globalThis.XF;
    const X = globalThis.XF;

    // ── 限流信号优先,**任何** X 接口的都要接住 ───────────────────
    // 以前这里先判 listType、非列表直接丢,于是"网关开始对所有路径返回 403"
    // 这个最先出现的前兆信号全部丢失 —— 熔断要等到下次扫列表才可能触发。
    const signal = G.isLimitSignal(msg.status, msg.body);
    if (signal) {
      const t = msg.listType === 'followers' ? 'followers' : 'following';
      if (!states[t].limitTripped) states[t].limitTripped = signal;
      G.trip(signal, null)
        .then(() => {
          for (const fn of limitListeners) {
            try {
              fn(signal);
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {});
      return { added: 0, limit: signal };
    }

    // ── 关注 / 取关:把"你刚做过什么"记下来 ────────────────────
    // 页面发这两个请求的唯一时机就是用户在 X 自己的界面上点了关注或取关。
    // 响应体里带目标用户,所以不用去读请求体就知道是谁。
    // 记下来之后名单会自己更新 —— 你点完切回来,那一行已经不在了。
    if (msg.listType === 'follow' || msg.listType === 'unfollow') {
      return recordServerAction(msg.listType, msg.body, msg.status, msg.url);
    }

    if (!msg.listType) return { added: 0 }; // 非列表且非限流:不关心

    const listType = msg.listType === 'followers' ? 'followers' : 'following';
    const s = states[listType];

    let parsed;
    try {
      parsed = X.extract(msg.body, msg.url, detectSelfHandle());
    } catch (e) {
      s.parseErrors.push(String(e && e.message ? e.message : e));
      return { added: 0 };
    }
    if (parsed.parseError) {
      s.parseErrors.push(parsed.parseError);
      return { added: 0, parsed };
    }

    const v = verifyOwner(parsed.owner, listType);
    if (!v.ok) {
      reject(listType, v.reason, msg.url);
      scheduleFlush();
      return { added: 0, rejected: v.reason };
    }
    if (parsed.owner && parsed.owner.id) {
      if (!s.ownerId) s.ownerId = parsed.owner.id;
      s.ownerVerified = s.ownerVerified || v.verified;
      if (parsed.owner.handle && !s.owner) s.owner = parsed.owner.handle;
    }
    if (!s.startedAt) s.startedAt = Date.now();

    s.suspects += parsed.suspects || 0;
    if (parsed.suspectNames && parsed.suspectNames.length) {
      s.suspectNames = s.suspectNames.concat(parsed.suspectNames).slice(-16);
    }
    if (parsed.stats) s.stats = parsed.stats;

    // 游标状态也要从解析结果更新 —— 包括"这是最后一页"。
    // 以前空末页会在更新游标之前就返回,导致 atEnd 永远进不来。
    if (parsed.cursors.bottom && !s.cursors.includes(parsed.cursors.bottom)) s.cursors.push(parsed.cursors.bottom);
    if (parsed.cursors.atEnd) s.atEnd = true;

    if (!parsed.users.length) {
      s.updatedAt = Date.now();
      scheduleFlush();
      emit(listType);
      return { added: 0, parsed };
    }

    const pageKey =
      parsed.cursors.bottom || parsed.cursors.nextCursor || `n${parsed.users.length}:${parsed.users[0].id}`;
    if (!s.seenPageKeys[pageKey]) {
      s.seenPageKeys[pageKey] = 1;
      s.pages++;
    }
    if (parsed.flagsAvailable) s.flagsAvailable = true;
    if (s.samples.length < 6 && parsed.samples && parsed.samples.length) {
      s.samples = s.samples.concat(parsed.samples).slice(0, 6);
    }

    let added = 0;
    for (const u of parsed.users) {
      const prev = s.users[u.id];
      if (prev) {
        // 同一代内以最新一条为准 —— 以前写成"只在旧值为 null 时更新",
        // 于是已知 true→false 被忽略。
        if (u.fb !== null && u.fb !== undefined) prev.fb = u.fb;
        if (u.f !== null && u.f !== undefined) prev.f = u.f;
        if (!prev.sn && u.sn) prev.sn = u.sn;
        if (prev.blueV === null && u.blueV != null) prev.blueV = u.blueV;
        continue;
      }
      s.users[u.id] = { sn: u.sn, fb: u.fb, f: u.f, blueV: u.blueV == null ? null : u.blueV };
      s.order.push(u.id);
      added++;
    }

    s.updatedAt = Date.now();
    scheduleFlush();
    emit(listType);
    return { added, parsed };
  }

  function onMessage(ev) {
    // 刻意不写 ev.source !== window 这个检查。隔离世界里的 window 和页面世界的
    // WindowProxy 在跨世界比较时并不保证全等,一旦不等就会静默丢掉**全部**数据。
    if (ev.origin !== location.origin) return;
    const data = ev.data;
    if (!data || typeof data !== 'object') return;

    if (data.__xf_nav__) {
      // 切到某张列表页 = 新一代。在页面发出列表请求之前清掉旧缓冲,
      // 这样首页落进干净的缓冲,而不是和上一轮累积的数据混在一起。
      const m = String(data.url || '').match(/\/([A-Za-z0-9_]+)\/(following|followers)(\/|\?|$)/i);
      if (m && m[1].toLowerCase() !== 'i') {
        const self = detectSelfHandle();
        if (!self || m[1].toLowerCase() === self.toLowerCase()) newGeneration(m[2].toLowerCase(), m[1]);
      }
      for (const fn of navListeners) {
        try {
          fn(data.url);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (data.__xf_ops__) {
      if (Array.isArray(data.ops)) {
        observedOps = data.ops.slice(-60);
        emit('following');
      }
      return;
    }

    if (!data.__xf_payload__) return;
    // ⚠ 这道守卫必须放行 follow / unfollow。
    //
    // 踩过:ingest 里加了处理动作消息的分支,但**入口先把它们丢掉了** ——
    // 于是"页面自己发出的关注/取关响应"永远到不了账本,快查那条链整条是死的,
    // 所有动作都被迫退到"重载页面复查"。当时测试是直接调 recordServerAction 的,
    // 绕过了这个入口,所以 183 条全绿而路是断的。
    // 教训:测一个"从消息进来"的能力,就必须从消息进来测。
    const lt = data.listType;
    const pass = lt === 'following' || lt === 'followers' || lt === 'follow' || lt === 'unfollow' || lt == null;
    if (!pass) return;
    ingest(data);
  }

  function install() {
    if (globalThis.__xfBridgeInstalled) return;
    globalThis.__xfBridgeInstalled = true;
    window.addEventListener('message', onMessage, false);
    // 把手动填写的身份读回来 —— 它是保证工具可用的兜底
    try {
      chrome.storage.local.get(['xf:selfHandle', CONFIRMED_KEY], (r) => {
        const h = r && r['xf:selfHandle'];
        if (typeof h === 'string' && h) {
          manualSelfHandle = h;
          selfHandle = h;
          selfSource = 'manual';
        }
        const c = r && r[CONFIRMED_KEY];
        if (!manualSelfHandle && typeof c === 'string' && c) confirmedSelf = c;
      });
    } catch {
      /* ignore */
    }
    // 页面加载 = 新一代:清掉上一次页面留下的缓冲。
    // 不清的话"重扫"会带着旧名单,"谁消失了"永远发现不了。
    newGeneration('following');
    newGeneration('followers');
    setTimeout(detectSelfHandle, 2500);
  }

  async function readBufferFromStorage(listType) {
    if (!chromeAlive() || !chrome.storage || !chrome.storage.local) return null;
    const key = KEY_OF(listType);
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (r) => resolve((r && r[key]) || null));
    });
  }

  return {
    BUFFER_KEY,
    BUFFER_KEY_FOLLOWERS,
    install,
    newGeneration,
    markConsumed,
    ingest,
    recordServerAction,
    lastServerAction: () => lastServerActionResult,
    count,
    getBuffer,
    detectSelfHandle,
    isSelfVerified,
    probeSelfHandle,
    rememberConfirmed,
    identity: () => ({ handle: selfHandle, source: selfSource, trusted: !!trustedSelf, candidate, confirmedByOwner }),
    setManualSelfHandle,
    handleFromNav,
    handleFromSettings,
    readBufferFromStorage,
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onNavigate(fn) {
      navListeners.add(fn);
      return () => navListeners.delete(fn);
    },
    onLimit(fn) {
      limitListeners.add(fn);
      return () => limitListeners.delete(fn);
    },
  };
});
