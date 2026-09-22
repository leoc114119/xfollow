// 扫描引擎:在你自己的关注列表 / 粉丝列表页面上缓慢滚动,把 X 应用自己加载出来的名单收全。
//
// 这里产生的网络请求**全部是 X 应用自己发的** —— 扩展只是滚动了一下页面,
// 和真人滚动的行为一致。但仍然要限速。
//
// 两张列表是两次独立的扫描,各自一份缓冲、各自一份快照:
//   following(我关注的人) → 查"谁没回关我"
//   followers(关注我的人) → 查"谁在等我回关"
//
// 踩过的坑,每一条都改了:
//   1. 旧版在 runScan 一开始 reset。但页面**早就把首页加载好了**,reset 等于丢掉首页,
//      而滚动只可能带来第 2 页起 —— 短名单会因此"捕获 0 条"。
//      现在改成:**换一代缓冲 = 重新加载页面**,首页必然落进干净的代次里。
//   2. 重扫时复用上一轮累积的缓冲,会让"谁消失了"永远发现不了。
//      现在靠"代次已消费"标记强制重载。
//   3. 旧版把"滚到了当前 DOM 底部"当成全量证明。慢请求、滚错容器、轮数耗尽都会
//      误判成"完整",于是没被读到的账号被记成"他取关了我"。现在要求可靠终止证据。
//   4. running=true 之后没有 try/finally,抛错会让按钮永久卡在运行态。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const U = typeof module === 'object' && module.exports ? require('../core/util.js') : globalThis.XF;
  const B = typeof module === 'object' && module.exports ? require('./bridge.js') : globalThis.XF;
  const L = typeof module === 'object' && module.exports ? require('../core/ledger.js') : globalThis.XF;
  const G = typeof module === 'object' && module.exports ? require('../core/guard.js') : globalThis.XF;

  const LIST_LABEL = { following: '关注列表', followers: '粉丝列表' };

  let running = false;
  let runningType = null;
  // 手动采集要单独记类型 —— 旧版把它清掉了,导致粉丝列表扫完被当成关注列表记账。
  let collectingType = null;
  let stopRequested = false;

  const PENDING_SCAN_KEY = 'xf:pendingScan';
  /** 每张列表各自最近一次扫描的结果 —— 只留一张会让排查失去依据 */
  const LAST_BY_LIST_KEY = 'xf:lastScanByList';
  const LAST_ACTION_KEY = 'xf:lastAction';
  const PENDING_MAX_AGE = 3 * 60 * 1000;

  const progressListeners = new Set();

  function storageSet(obj) {
    if (!U.chromeAlive() || !chrome.storage || !chrome.storage.local) return Promise.resolve();
    return new Promise((r) => chrome.storage.local.set(obj, () => r()));
  }

  function storageGet(key) {
    if (!U.chromeAlive() || !chrome.storage || !chrome.storage.local) return Promise.resolve(null);
    return new Promise((r) => chrome.storage.local.get([key], (res) => r(res ? res[key] : null)));
  }

  function setLastAction(patch) {
    return storageSet({ [LAST_ACTION_KEY]: Object.assign({ ts: Date.now() }, patch) });
  }

  function clearPendingScan() {
    return storageSet({ [PENDING_SCAN_KEY]: null });
  }

  function notify(info) {
    for (const fn of progressListeners) {
      try {
        fn(info);
      } catch {
        /* ignore */
      }
    }
  }

  function currentPage() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/(following|followers)\/?$/i);
    if (!m) return null;
    const handle = m[1];
    if (handle.toLowerCase() === 'i') return null;
    return { handle, listType: m[2].toLowerCase() };
  }

  function isEligible(wantListType, opts = {}) {
    const page = currentPage();
    if (!page) return { ok: false, reason: '当前不是关注列表或粉丝列表页' };
    const self = B.detectSelfHandle();
    if (!self) return { ok: false, reason: '还读不到你自己的用户名,稍等页面加载完再试' };
    if (self.toLowerCase() !== page.handle.toLowerCase()) {
      return { ok: false, reason: `这是 @${page.handle} 的列表,不是你的。为避免污染数据,只扫你自己的。` };
    }
    if (!opts.allowAnyType && wantListType && page.listType !== wantListType) {
      return {
        ok: false,
        reason: `当前是${LIST_LABEL[page.listType]},但要扫的是${LIST_LABEL[wantListType]}。`,
        mismatch: true,
        onPage: page.listType,
      };
    }
    return { ok: true, page, self, listType: page.listType };
  }

  /**
   * 找滚动容器。**必须跳过我们自己的抽屉** —— 它也是 overflow:auto 的 div,
   * 会被这个启发式选中,然后"滚到底部"变成滚抽屉自己。
   */
  function findScroller() {
    const own = document.getElementById('xf-sb');
    const isOwn = (el) => !!(own && (el === own || own.contains(el)));
    const se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 200) return se;
    let best = null;
    let bestGap = 200;
    for (const el of document.querySelectorAll('div')) {
      if (isOwn(el)) continue;
      const gap = el.scrollHeight - el.clientHeight;
      if (gap > bestGap && el.clientHeight > 200) {
        const ov = getComputedStyle(el).overflowY;
        if (ov === 'auto' || ov === 'scroll') {
          bestGap = gap;
          best = el;
        }
      }
    }
    return best || se;
  }

  function atBottom(el) {
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 400;
  }

  function nudgeScroll() {
    const el = findScroller();
    try {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch {
      /* ignore */
    }
    try {
      window.scrollTo(0, document.body.scrollHeight);
    } catch {
      /* ignore */
    }
    return el;
  }

  /**
   * 等列表**真的长出来**。
   *
   * 为什么要轮询而不是固定 sleep:固定等待把两件事混成了一件 ——
   * "响应慢"和"没有下一页"在固定窗口里长得一模一样,于是慢响应会被误判成到底了
   * (扫描被过早判为完整)。而且固定节奏对 X 偏急,长列表容易把页面拖垮
   * (真机反馈:扫太多之后页面不加载了,要等一会儿)。
   */
  async function waitForGrowth(listType, from, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (stopRequested) return 'stopped';
      if (B.count(listType) > from) return 'grew';
      if (B.getBuffer(listType).atEnd) return 'end';
      await U.sleep(500);
    }
    return 'timeout';
  }

  /**
   * 滚动直到可靠终止。返回的证据用于判断"这次是不是完整"。
   * exhausted(轮数耗尽)也是"不可靠终止"的一种。
   */
  /** 上限。<=0 或非数字 = 不限量(无限大),于是 atCap 永远为 false,能滚到底 */
  function capOf(config) {
    const n = Number(config && config.cap);
    return isFinite(n) && n > 0 ? n : Infinity;
  }

  async function autoScroll(listType, config, onTick) {
    let stale = 0;
    let rounds = 0;
    let last = B.count(listType);
    let sawBottom = false;
    const minMs = Math.round(config.scrollPauseMin * 1000);
    const maxMs = Math.round(config.scrollPauseMax * 1000);

    while (rounds < config.maxRounds) {
      if (stopRequested) break;
      if (last >= capOf(config)) break;
      if (B.getBuffer(listType).atEnd) break;
      rounds++;

      nudgeScroll();
      // 先给人手的停顿,再等真的长出来(最多等到间隔上限的 2.5 倍)
      await U.humanDelay(config.scrollPauseMin, config.scrollPauseMax);
      const grew = await waitForGrowth(listType, last, Math.round(U.randInt(minMs, maxMs) * 2.5));

      const now = B.count(listType);
      const el = findScroller();
      // cap<=0 = 不限量(扫到底)。有些判断只能靠"完整名单"才成立:
      // 「他不在名单里了」必须建立在"我把名单看全了"之上,否则就是瞎猜。
      const bottom = atBottom(el);
      if (bottom) sawBottom = true;
      if (onTick) onTick({ rounds, count: now, cap: config.cap, bottom, waited: grew === 'timeout' });

      if (grew === 'stopped') break;
      if (grew === 'grew') {
        stale = 0;
        last = now;
      } else if (bottom) {
        stale++;
        if (stale >= config.staleRounds) break;
      }

      // 页面还在忙(文档没加载完)就多歇一会儿 —— 长列表被拖垮主要是积压造成的
      try {
        if (document.readyState !== 'complete') await U.sleep(2000);
      } catch {
        /* ignore */
      }
    }
    return {
      rounds,
      count: B.count(listType),
      stopped: stopRequested,
      sawBottom,
      atCap: last >= capOf(config),
      exhausted: rounds >= config.maxRounds,
    };
  }

  /** 把缓冲区记成一次快照。手动模式和自动模式都走这里。 */
  async function finishScan(listType, opts = {}) {
    const state = await L.loadState();
    const config = state.config;
    const buf = B.getBuffer(listType);
    const entries = buf.users || {};
    const count = Object.keys(entries).length;
    const sr = opts.scrollResult || null;

    // 完整性判据,按可靠度排序:
    //   ① 游标/末页明确说了到底 —— 最硬的证据
    //   ② 自动模式滚到了底部,而且不是因为停止/上限/轮数耗尽才停
    // 手动模式只有 ① 可用:用户说"我滚完了"不是证据(他没滚到底我们也无从知道)。
    const confirmedEnd = !!(
      buf.atEnd ||
      (sr && sr.sawBottom && !sr.stopped && !sr.atCap && !sr.exhausted && !opts.manual)
    );
    const incomplete = !confirmedEnd || !!buf.limitTripped || !buf.flagsAvailable;

    // 零条也要能记账 —— 真实的空列表(所有人都取关了我)必须能被记录下来,
    // 否则"最后一个粉丝消失"永远发现不了。只有"零条 + 没有终止证据"才是加载失败。
    if (!count && !confirmedEnd) {
      collectingType = null;
      const msg = `这个页面上一条${LIST_LABEL[listType]}都没读到,而且没能确认列表已经加载完。先手动往下滚两屏再试。`;
      notify({ kind: 'scan', listType, ok: false, message: msg });
      await setLastAction({ kind: 'scan', listType, ok: false, message: msg });
      return { ok: false, reason: msg };
    }

    const result = await L.recordScan({
      ts: Date.now(),
      listType,
      owner: buf.owner || B.detectSelfHandle(),
      ownerId: buf.ownerId || null,
      ownerVerified: !!buf.ownerVerified,
      entries,
      order: buf.order,
      cap: config.cap,
      incomplete,
      flagsAvailable: buf.flagsAvailable,
      tierA: count,
      suspects: buf.suspects,
      entryStats: buf.stats,
    });

    collectingType = null;
    // 这一代缓冲已经用过了 —— 下次扫描必须重新加载页面拿干净的
    B.markConsumed(listType);

    const s = result.summary;
    const notes = [];
    if (result.staleBaselineDiscarded) notes.push('旧基线已作废(证据清零重建)');
    if (s.unknown) notes.push(`读不到关系标志 ${s.unknown}`);
    if (!buf.flagsAvailable) notes.push('⚠ 响应里没有关系标志');
    if (buf.suspects) notes.push(`另排除推荐位用户 ${buf.suspects}`);
    if (incomplete) notes.push('本次不完整,未覆盖的人保持未知、不可操作');
    // 关系标志不在的话,"他有没有回关我"就算不出来(未回关那半边全靠它)。
    // 这句话必须说出来,否则用户看到的是一个静悄悄算不出来的 0。
    if (!buf.flagsAvailable) notes.push('⚠ 响应里没有关系标志,算不出"他有没有回关我"');

    const summaryLine = `${LIST_LABEL[listType]}:捕获 ${s.total} 条` + (notes.length ? ' · ' + notes.join(' · ') : '');

    notify({
      kind: 'scan',
      listType,
      ok: buf.flagsAvailable,
      message: summaryLine,
      summary: s,
      isBaseline: result.isBaseline,
      incomplete,
    });
    // 两张列表的结果要**分别记下来**,不能只留最后一张。
    // 之前只写一条 message,后扫的那张会把先扫的覆盖掉 ——
    // 而"未回关"主要靠关注列表,结果那一条正好看不见,排查时完全没有依据。
    const prevByList = (await storageGet(LAST_BY_LIST_KEY)) || {};
    const byList = Object.assign({}, prevByList, {
      [listType]: {
        ts: Date.now(),
        count: s.total,
        flags: !!buf.flagsAvailable,
        incomplete,
        notes,
      },
    });
    await storageSet({ [LAST_BY_LIST_KEY]: byList });
    await setLastAction({ kind: 'scan', listType, ok: buf.flagsAvailable, message: summaryLine, byList });
    return { ok: true, listType, summary: s, isBaseline: result.isBaseline, events: result.events.length, incomplete };
  }

  async function finishManual() {
    const listType = collectingType;
    if (!listType) return { ok: false, reason: '当前不在手动采集状态' };
    if (running) return { ok: false, reason: '正在处理中' };
    running = true;
    try {
      return await finishScan(listType, { manual: true });
    } finally {
      running = false;
    }
  }

  /** 手动模式:只进入采集状态,等用户滚完自己点「完成并记账」 */
  function startCollecting(listType) {
    collectingType = listType;
    notify({
      kind: 'scan',
      listType,
      ok: null,
      message: `手动采集${LIST_LABEL[listType]}:往下滚,滚完点「完成并记账」。当前 ${B.count(listType)} 条。`,
    });
    return setLastAction({
      kind: 'scan',
      listType,
      ok: null,
      message: `手动采集${LIST_LABEL[listType]}:滚动列表,滚完点「完成并记账」`,
    }).then(() => ({ ok: true, collecting: true, listType }));
  }

  async function runScan(wantListType, opts) {
    if (running) return { ok: false, reason: '已经在扫描中' };
    if (collectingType) return { ok: false, reason: '正在手动采集,先点「完成并记账」或重新加载页面' };

    const elig = isEligible(wantListType, { allowAnyType: !wantListType });
    if (!elig.ok) {
      notify({ kind: 'scan', listType: wantListType, ok: false, message: elig.reason });
      await setLastAction({ kind: 'scan', listType: wantListType, ok: false, message: elig.reason });
      return { ok: false, reason: elig.reason, mismatch: !!elig.mismatch, onPage: elig.onPage };
    }
    const listType = elig.listType;

    // 只读操作只看熔断,不看写配额 —— 取关配额用完不该挡住扫描
    const gate = await G.canScan();
    if (!gate.ok) {
      notify({ kind: 'scan', listType, ok: false, message: gate.reason });
      await setLastAction({ kind: 'scan', listType, ok: false, message: gate.reason });
      return { ok: false, reason: gate.reason };
    }

    running = true;
    runningType = listType;
    stopRequested = false;
    let completed = false;

    try {
      const state0 = await L.loadState();
      // opts.full:这次扫到底。**只有"他不在名单里了"这种判断才需要它** ——
      // 那种判断建立在"我看全了"之上,看不全就什么都不能说。
      const config = opts && opts.full ? Object.assign({}, state0.config, { cap: 0 }) : state0.config;

      // 以前这里有个"自动滚动 / 手动滚动"的分支。手动那种模式已经不在界面上,
      // 而且旧的存储里可能还留着 autoScroll:false —— 所以直接不看这个开关了,
      // 一直走自动滚动。留着一个读不到的分支只会让人以为它还在起作用。
      notify({ kind: 'scan', listType, ok: null, message: `正在收集${LIST_LABEL[listType]}…` });
      await setLastAction({ kind: 'scan', listType, ok: null, message: `正在收集${LIST_LABEL[listType]}…` });

      const scrollResult = await autoScroll(listType, config, ({ rounds, count, cap, waited }) => {
        notify({
          kind: 'progress',
          listType,
          message: `第 ${rounds} 轮 · 已捕获 ${count} 条${cap && isFinite(cap) ? ` / 上限 ${cap}` : ''}${
            waited ? ' · 在等这一页加载(慢是正常的)' : ''
          }`,
        });
      });

      const r = await finishScan(listType, { scrollResult });
      completed = true;
      return r;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      notify({ kind: 'scan', listType, ok: false, message: '扫描出错:' + msg });
      await setLastAction({ kind: 'scan', listType, ok: false, message: '扫描出错:' + msg });
      return { ok: false, reason: msg };
    } finally {
      running = false;
      runningType = null;
      if (!completed && !collectingType) notify({ kind: 'idle', listType });
    }
  }

  function stopScan() {
    stopRequested = true;
    notify({ kind: 'progress', listType: runningType || collectingType, message: '已请求停止…' });
  }

  /** 跳到自己的某张列表页;已经在这一页就重新加载,换一代干净的缓冲。 */
  function openListPage(listType, handle) {
    const kind = listType === 'followers' ? 'followers' : 'following';
    const h = handle || B.detectSelfHandle();
    const target = h ? `https://x.com/${h}/${kind}` : `https://x.com/${kind}`;
    const here = currentPage();
    if (here && here.listType === kind && (!h || here.handle.toLowerCase() === h.toLowerCase())) {
      location.reload();
      return target;
    }
    location.href = target;
    return target;
  }

  /**
   * 用户点"扫列表"时的入口。
   * 需要一份**干净代次**的缓冲:直接扫会把上一轮累积的旧名单一起算进去,
   * "谁消失了"就永远发现不了。所以只有"这一代还没被消费过"时才直接扫。
   */
  /**
   * 扫一次。
   *
   * **两张列表都要扫**,不能只扫一张。原因:
   *   未回关 = 我关注了他 && 他没回关我
   *   回关检测 = 他关注我 && 我没回关他
   * 两个判断都同时需要"我关注谁"和"谁关注我"两个事实,而它们分别来自关注列表和粉丝列表。
   * 只扫一张的话,另一半只能靠响应里的 followed_by 标志 —— 而那个标志不一定在,
   * 不在的时候"他没回关我"永远算不出来,名单就是空的(用户报的正是这个)。
   *
   * queue 里放的是**接下来还要扫的**,扫完一张自动接着下一张。
   */
  async function requestScan(listType, opts) {
    const want = listType === 'followers' ? 'followers' : 'following';
    const page = currentPage();
    const self = B.detectSelfHandle();
    const sameSelf = page && self && page.handle.toLowerCase() === self.toLowerCase();
    const buf = B.getBuffer(want);
    const freshGeneration = sameSelf && page.listType === want && buf.count > 0 && !buf.consumedAt;

    if (freshGeneration) return runScan(want, opts);

    // 只扫这一张。**不要顺手把另一张也扫了**:
    //   · 未回关只需要关注列表 —— 关注列表的响应里有 followed_by,能直接看出他回没回关
    //   · 回关检测只需要粉丝列表
    // 多扫一张既费时,又会让用户看到页面莫名其妙跳到另一张列表上去。
    await storageSet({ [PENDING_SCAN_KEY]: { ts: Date.now(), listType: want, queue: [], full: !!opts.full } });
    openListPage(want, self);
    return { ok: true, navigating: true, listType: want };
  }

  /** 认领"待扫描"标记(页面加载完 / 路由变化时调用)。 */
  async function consumePendingScan() {
    const p = await storageGet(PENDING_SCAN_KEY);
    if (!p || !p.ts) return;
    if (Date.now() - p.ts > PENDING_MAX_AGE) {
      await clearPendingScan();
      return;
    }
    await clearPendingScan();
    const want = p.listType === 'followers' ? 'followers' : 'following';

    // 等 X 把名单请求发出来。页面 DOM 就绪 ≠ 名单已加载。
    await U.sleep(2500);

    const elig = isEligible(want);
    if (!elig.ok) {
      notify({ kind: 'scan', listType: want, ok: false, message: elig.reason });
      await setLastAction({ kind: 'scan', listType: want, ok: false, message: elig.reason });
      return;
    }
    let res = null;
    try {
      res = await runScan(want, { full: !!p.full });
    } catch (e) {
      notify({ kind: 'scan', listType: want, ok: false, message: String(e && e.message ? e.message : e) });
      return;
    }

    // 还有下一张列表要扫 → 记下来并跳过去,到了那边会自动接着跑
    const queue = Array.isArray(p.queue) ? p.queue.filter((t) => t === 'following' || t === 'followers') : [];
    if (res && res.ok && queue.length) {
      await storageSet({ [PENDING_SCAN_KEY]: { ts: Date.now(), listType: queue[0], queue: queue.slice(1), full: !!p.full } });
      openListPage(queue[0], B.detectSelfHandle());
    }
  }

  function isScanRunning() {
    return running || !!collectingType;
  }

  function installMessageHandler() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
    const respond = (sendResponse, payload) => {
      try {
        sendResponse(payload);
      } catch {
        /* 面板已关闭 */
      }
    };
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'xf:scan') {
        clearPendingScan();
        requestScan(msg.listType)
          .then((r) => respond(sendResponse, r))
          .catch((e) => respond(sendResponse, { ok: false, reason: String(e && e.message ? e.message : e) }));
        return true;
      }
      if (msg.type === 'xf:scan-finish') {
        finishManual()
          .then((r) => respond(sendResponse, r))
          .catch((e) => respond(sendResponse, { ok: false, reason: String(e && e.message ? e.message : e) }));
        return true;
      }
      if (msg.type === 'xf:stop') {
        stopScan();
        respond(sendResponse, { ok: true });
        return true;
      }
      if (msg.type === 'xf:toggle-sidebar') {
        const X = globalThis.XF;
        if (X && typeof X.sidebarToggle === 'function') X.sidebarToggle();
        else if (X && typeof X.fallbackNotice === 'function') {
          X.fallbackNotice(
            '侧边栏脚本没加载成功(点这里关掉)。请刷新页面;若反复出现,去 chrome://extensions 看这个扩展的错误列表。'
          );
        }
        respond(sendResponse, { ok: true });
        return true;
      }
      return undefined;
    });
  }

  function boot() {
    // 监听必须在脚本一加载就挂上,不能等 DOMContentLoaded。
    // X 可能在 DOM 就绪之前就发出列表请求,晚挂一步就会永远丢那一页。
    B.install();
    installMessageHandler();

    const onRouteChange = () => {
      if (running || collectingType) {
        stopRequested = true;
        collectingType = null;
      }
      consumePendingScan().catch(() => {});
    };

    const afterDom = () => {
      onRouteChange();
      B.onNavigate(onRouteChange);
      let lastHref = location.href;
      const navTimer = setInterval(() => {
        // 上下文死了(扩展被重载)就停机 —— 否则这个定时器会一直抛
        if (!U.chromeAlive()) {
          clearInterval(navTimer);
          return;
        }
        if (location.href !== lastHref) {
          lastHref = location.href;
          onRouteChange();
        }
      }, 1000);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterDom);
    else afterDom();
  }

  if (typeof document !== 'undefined') boot();

  return {
    runScan,
    requestScan,
    finishManual,
    stopScan,
    isEligible,
    currentPage,
    openListPage,
    consumePendingScan,
    findScroller,
    autoScroll,
    isScanRunning,
    collectingType: () => collectingType,
    runningType: () => runningType,
    LIST_LABEL,
    onProgress(fn) {
      progressListeners.add(fn);
      return () => progressListeners.delete(fn);
    },
    // 供测试触发一次通知。界面靠这些通知决定"什么时候该重读账本",
    // 而"扫描完成后名单没刷新"正是这里漏了一次导致的 —— 值得能直接测。
    _emitProgress: notify,
  };
});
