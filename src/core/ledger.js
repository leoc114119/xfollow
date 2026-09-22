// 落盘账本。全部数据只存在 chrome.storage.local —— 不联网、不落任何服务器。
//
// 为什么必须持久化而不是放内存:进程会被杀(标签页刷新、SPA 休眠),
// 内存里的记录一丢,下次就会对同一个账号重复动作 —— 这是最典型的机器人信号。
//
// ══ 关系表的数据模型 ════════════════════════════════════════════
// 工具要回答两个独立的问题,它们由两张不同的列表提供:
//   iFollow   = 我关注他吗   ← 我的关注列表里有没有他 / 粉丝列表给的 following
//   heFollows = 他关注我吗   ← 我的粉丝列表里有没有他 / 关注列表给的 followed_by
//
// 关键设计:**每个事实按来源分别存观测,不存"一个结论"**。
//   rel.obs.iFollow   = { following: {v,at,seq}, followers: {v,at,seq} }
//   rel.obs.heFollows = { following: {...},     followers: {...} }
// 展示时取**最新**的那条观测(时间相同则完整扫描的否定压过肯定)。
//
// 为什么不能存"一个结论"并做字段级合并 —— 上一版就是这么写的,结果是:
//   · 先扫关注列表得 iFollow=true,再扫粉丝列表得 following=false,
//     合并规则"true 优先"让新的否定永远盖不过旧的肯定 → 回关检测永久漏人;
//   · 某人从粉丝列表消失后,粉丝列表给的那个值再也不刷新,陈旧值一直压着新的权威观测;
//   · 本轮读不到状态时沿用历史值,于是"未知"的行看着像"已确认",还能被取关。
// 这三条都是审查实机复现过的。
//
// 历史和现状也必须分开:
//   observedHeFollowStartAt 只在**观测到 false→true** 时设立 —— 它是"他开始关注我"的下界。
//   首次看到就是 true 只能证明"那时他关注我",不能当天开始关注时刻 ——
//   拿它当起始会冤枉互关多年的老账号(第二天取关就判"快速取关")。
//   heStoppedAt 是最近一次"观测到 true→false"的时刻,重新关注不会抹掉它。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const U = typeof module === 'object' && module.exports ? require('./util.js') : globalThis.XF;

  const KEYS = {
    CONFIG: 'xf:config',
    SNAP: 'xf:snapshot',
    SNAP_FOLLOWERS: 'xf:snapshot:followers',
    REL: 'xf:relations',
    EV: 'xf:events',
    MARKS: 'xf:marks',
    QUOTA: 'xf:quota',
    STATS: 'xf:stats',
    WHITELIST: 'xf:whitelist',
  };

  const MAX_EVENTS = 3000;

  const DEFAULT_CONFIG = {
    // 只扫最近这么多。两个列表各自按这个数封顶 ——
    // 只关心最近的关系变化,越久远越没有行动价值,而且扫得越深越容易触发限流。
    cap: 200,

    // 滚动节奏。这几个是"别把页面刷出限流"的护栏,不是给用户调的旋钮。
    maxRounds: 40,
    scrollPauseMin: 1.5,
    scrollPauseMax: 4,
    staleRounds: 3,

  };

  function storage() {
    // 上下文失效时不要抛 —— 上层(定时器、面板渲染)会因为一个无害的孤儿脚本
    // 而刷一屏报错。退化成"读不到",让调用方走各自的空值分支。
    if (!U.chromeAlive() || !chrome.storage || !chrome.storage.local) return null;
    return chrome.storage.local;
  }

  function get(keys) {
    const st = storage();
    if (!st) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      st.get(keys, (res) => {
        const err = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res || {});
      });
    });
  }

  function set(obj) {
    const st = storage();
    if (!st) return Promise.resolve();
    return new Promise((resolve, reject) => {
      st.set(obj, (res) => {
        const err = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
  }

  function remove(keys) {
    const st = storage();
    if (!st) return Promise.resolve();
    return new Promise((resolve, reject) => {
      st.remove(keys, () => {
        const err = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  // 读改写必须串行,否则同一上下文内会互相覆盖。
  // 注意:这是**进程内**的锁,跨标签页无效 —— 跨标签页靠 guard 的队列租约。
  const withLock = U.makeQueue();

  async function loadState() {
    const raw = await get([
      KEYS.CONFIG,
      KEYS.SNAP,
      KEYS.SNAP_FOLLOWERS,
      KEYS.REL,
      KEYS.EV,
      KEYS.MARKS,
      KEYS.QUOTA,
      KEYS.STATS,
      KEYS.WHITELIST,
    ]);
    return {
      config: Object.assign({}, DEFAULT_CONFIG, raw[KEYS.CONFIG] || {}),
      snapshot: raw[KEYS.SNAP] || null,
      snapshotFollowers: raw[KEYS.SNAP_FOLLOWERS] || null,
      relations: raw[KEYS.REL] || {},
      events: raw[KEYS.EV] || [],
      marks: raw[KEYS.MARKS] || {},
      whitelist: raw[KEYS.WHITELIST] || {},
      quota: raw[KEYS.QUOTA] || null,
      stats: raw[KEYS.STATS] || { scans: 0, seqs: { following: 0, followers: 0 } },
    };
  }

  async function setConfig(patch) {
    return withLock(async () => {
      const raw = await get([KEYS.CONFIG]);
      const next = Object.assign({}, DEFAULT_CONFIG, raw[KEYS.CONFIG] || {}, patch || {});
      await set({ [KEYS.CONFIG]: next });
      return next;
    });
  }

  // ── 关系表 ────────────────────────────────────────────────
  function newRelation(sn, ts) {
    return {
      sn: sn || null,
      avatar: null,
      blueV: null,
      blueVAt: null,
      firstSeen: ts,
      lastSeen: ts,
      obs: { iFollow: {}, heFollows: {} },
      // 历史只追加。区间端点可以闭合,但不被后来的观测抹掉。
      everHeFollowed: false,
      observedHeFollowStartAt: null, // 只在观测到 false→true 时设立
      heStoppedAt: null, // 最近一次观测到 true→false
      heStoppedVia: null,
      heStoppedCount: 0,
      iFollowSince: null, // 只在观测到我方 false→true 时设立
      iStoppedAt: null,
    };
  }

  function ensureShape(r, ts) {
    if (!r.obs) r.obs = { iFollow: {}, heFollows: {} };
    if (!r.obs.iFollow) r.obs.iFollow = {};
    if (!r.obs.heFollows) r.obs.heFollows = {};
    if (r.firstSeen == null) r.firstSeen = ts;
    if (r.heStoppedCount == null) r.heStoppedCount = 0;
    if (r.everHeFollowed == null) r.everHeFollowed = false;
    if (r.avatar === undefined) r.avatar = null; // 老数据没有这个字段,补成 null 让界面走首字母兜底
    return r;
  }

  /**
   * 写一条观测,并顺带维护历史区间端点。
   * 历史端点只在**观测到转变**时移动 —— 这是"不冤枉人"的关键。
   */
  function applyObservation(rel, fact, source, v, ts, seq, complete) {
    const prev = rel.obs[fact][source] || null;
    rel.obs[fact][source] = { v, at: ts, seq, complete: !!complete };

    if (fact === 'heFollows') {
      if (v === true) {
        if (!rel.everHeFollowed) rel.everHeFollowed = true;
        // 只有"上次明确看到 false、这次看到 true"才算观测到关系建立
        if (prev && prev.v === false) rel.observedHeFollowStartAt = ts;
      } else if (v === false) {
        // 只有"上次明确看到 true"才算观测到关系中断。
        // 首次看到 false 不能反推出"他刚取关我"。
        if (prev && prev.v === true) {
          if (rel.heStoppedAt == null || ts > rel.heStoppedAt) {
            rel.heStoppedAt = ts;
            rel.heStoppedVia = source === 'followers' ? '从粉丝列表消失' : 'followed_by 翻转为 false';
            rel.heStoppedCount += 1;
          }
        }
      }
    }

    if (fact === 'iFollow') {
      if (v === true) {
        if (prev && prev.v === false) rel.iFollowSince = ts;
        else if (rel.iFollowSince == null) rel.iFollowSince = ts;
      } else if (v === false && prev && prev.v === true) {
        rel.iStoppedAt = ts;
      }
    }
  }

  /**
   * 把一次扫描的观测并进关系表。
   *
   * 两张列表各提供哪些事实:
   *   我的关注列表:出现在里面 ⇒ iFollow=true;它的 followed_by ⇒ heFollows
   *   我的粉丝列表:出现在里面 ⇒ heFollows=true;它的 following ⇒ iFollow
   * 完整扫描里**没出现**也是观测:该来源的事实为 false。
   */
  function mergeObservations(rel, entries, listType, ts, incomplete, seq) {
    const isFollowers = listType === 'followers';
    const complete = !incomplete;

    for (const id of Object.keys(entries)) {
      const e = entries[id];
      if (!rel[id]) rel[id] = newRelation(e.sn, ts);
      const r = ensureShape(rel[id], ts);
      if (e.sn && r.sn !== e.sn) r.sn = e.sn;
      if (e.avatar && r.avatar !== e.avatar) r.avatar = e.avatar;
      if (typeof e.blueV === 'boolean') {
        r.blueV = e.blueV;
        r.blueVAt = ts;
      }
      r.lastSeen = ts;

      if (isFollowers) {
        // 在粉丝列表里 → 他关注我(这是该列表的定义)
        applyObservation(r, 'heFollows', 'followers', true, ts, seq, complete);
        // 该列表给的 following 就是我关注他吗
        if (typeof e.f === 'boolean') applyObservation(r, 'iFollow', 'followers', e.f, ts, seq, complete);
      } else {
        // 在关注列表里 → 我关注他(这是该列表的定义)
        applyObservation(r, 'iFollow', 'following', true, ts, seq, complete);
        if (typeof e.fb === 'boolean') applyObservation(r, 'heFollows', 'following', e.fb, ts, seq, complete);
      }
    }

    // 本次没出现的。完整扫描下这是"该来源的事实为 false"的可靠观测;
    // 不完整时什么都不写 —— 没观测到 ≠ 关系变化。
    if (complete) {
      for (const id of Object.keys(rel)) {
        if (entries[id]) continue;
        const r = ensureShape(rel[id], ts);
        if (isFollowers) applyObservation(r, 'heFollows', 'followers', false, ts, seq, true);
        else applyObservation(r, 'iFollow', 'following', false, ts, seq, true);
      }
    }
  }

  /**
   * 记一次扫描:和**同一张列表**的上一份快照差分,更新关系表,产出事件。
   * @param scan { listType, owner, ownerId, entries, order, cap, incomplete, flagsAvailable,
   *               tierA, suspects, entryStats, ts, ownerVerified }
   */
  async function recordScan(scan) {
    return withLock(async () => {
      const state = await loadState();
      const ts = scan.ts || Date.now();
      const S = typeof module === 'object' && module.exports ? require('./snapshot.js') : globalThis.XF;
      const listType = scan.listType === 'followers' ? 'followers' : 'following';

      const entries = scan.entries || {};
      const curIncomplete = !!scan.incomplete;
      const curSnap = listType === 'followers' ? state.snapshotFollowers : state.snapshot;
      const otherSnap = listType === 'followers' ? state.snapshot : state.snapshotFollowers;

      const checkBaseline = (snap) => {
        if (!snap) return { usable: null, stale: false };
        const versionOk = snap.v === S.SNAPSHOT_VERSION;
        const ownerOk =
          snap.ownerId && scan.ownerId
            ? snap.ownerId === scan.ownerId
            : !snap.owner || !scan.owner || snap.owner === scan.owner;
        return versionOk && ownerOk ? { usable: snap, stale: false } : { usable: null, stale: true };
      };
      const cur = checkBaseline(curSnap);
      const other = checkBaseline(otherSnap);
      const usablePrev = cur.usable;
      const staleBaselineDiscarded = cur.stale || other.stale;

      // 出现失效基线时,**两份快照都作废一次就够**。
      // 上一版只跳过事件差分、不清另一维度的旧快照,于是那份永久失效的快照
      // 每次扫描都触发一次"清空共享证据"—— 新证据刚生成就被清掉,反复循环。
      if (staleBaselineDiscarded) {
        await remove([KEYS.SNAP, KEYS.SNAP_FOLLOWERS]);
      }

      const followedAt = {};
      for (const id of Object.keys(state.relations)) {
        followedAt[id] = state.relations[id].firstSeen;
      }

      let events = [];
      if (usablePrev && usablePrev.entries) {
        events = S.diffEntries(usablePrev.entries, entries, {
          ts,
          listType,
          followedAt,
          prevTruncated: !!usablePrev.truncated,
          curIncomplete,
        });
      }

      // ── 观测序号:用来判断"这条观测是不是本轮的" ──────────────
      const seqs = Object.assign({ following: 0, followers: 0 }, (state.stats && state.stats.seqs) || {});
      const seq = (seqs[listType] || 0) + 1;
      seqs[listType] = seq;

      // ── 关系表 ──────────────────────────────────────────────
      const rel = {};
      for (const id of Object.keys(state.relations)) rel[id] = ensureShape(Object.assign({}, state.relations[id]), ts);

      if (staleBaselineDiscarded) {
        // 自动证据全部清零,等重新观测。手动标记和白名单另行保存,不受影响。
        for (const id of Object.keys(rel)) {
          const r = rel[id];
          r.obs = { iFollow: {}, heFollows: {} };
          r.everHeFollowed = false;
          r.observedHeFollowStartAt = null;
          r.heStoppedAt = null;
          r.heStoppedVia = null;
          r.heStoppedCount = 0;
          r.iFollowSince = null;
          r.iStoppedAt = null;
        }
      }

      mergeObservations(rel, entries, listType, ts, curIncomplete, seq);

      const snapshot = S.buildSnapshot({
        ts,
        listType,
        owner: scan.owner,
        ownerId: scan.ownerId || null,
        ownerVerified: !!scan.ownerVerified,
        cap: scan.cap,
        truncated: curIncomplete,
        scanned: Object.keys(entries).length,
        order: scan.order,
        entries,
      });

      const allEvents = events.concat(state.events).slice(0, MAX_EVENTS);
      const prefix = listType === 'followers' ? 'followers.' : '';
      const stats = Object.assign({}, state.stats, {
        scans: (state.stats.scans || 0) + 1,
        seqs,
        [`${prefix}lastScanTs`]: ts,
        [`${prefix}flagsAvailable`]: scan.flagsAvailable,
        [`${prefix}lastScanTruncated`]: curIncomplete,
        [`${prefix}lastScanCount`]: Object.keys(entries).length,
        [`${prefix}lastScanSuspects`]: scan.suspects || 0,
        [`${prefix}lastScanStats`]: scan.entryStats || null,
        [`${prefix}ownerVerified`]: !!scan.ownerVerified,
        ...(listType === 'following'
          ? {
              lastScanTs: ts,
              flagsAvailable: scan.flagsAvailable,
              lastScanTruncated: curIncomplete,
              lastScanCount: Object.keys(entries).length,
              lastScanTierA: scan.tierA || Object.keys(entries).length,
              lastScanSuspects: scan.suspects || 0,
              lastScanStats: scan.entryStats || null,
            }
          : {}),
      });

      await set({
        [listType === 'followers' ? KEYS.SNAP_FOLLOWERS : KEYS.SNAP]: snapshot,
        [KEYS.REL]: rel,
        [KEYS.EV]: allEvents,
        [KEYS.STATS]: stats,
      });

      return {
        events,
        snapshot,
        listType,
        summary: S.summarize(entries),
        isBaseline: !usablePrev,
        staleBaselineDiscarded,
        incomplete: curIncomplete,
        seq,
      };
    });
  }

  /**
   * 记下**页面自己**做过的一次关注 / 取关。
   *
   * 和"我们自己执行动作"不同:这是用户在 X 界面上亲手点的(或者工具替他点的),
   * 我们只是被动读到了它的响应,或者重新加载页面后读到了结果。
   * 来源写成 server / page —— 都是 X 自己给出的状态,比任何推断都硬。
   * 下次扫列表会给出更权威的值,两者按"最新观测胜出"合并,不冲突。
   */
  async function applyServerAction(id, sn, following, ts, source) {
    if (!id) return { ok: false, reason: '没有用户 id' };
    return withLock(async () => {
      const state = await loadState();
      const when = ts || Date.now();
      const rel = Object.assign({}, state.relations);
      const r = ensureShape(rel[id] || newRelation(sn, when), when);
      if (sn && !r.sn) r.sn = sn;
      // seq 用一个不可能与扫描撞上的负数:这类观测没有"第几轮扫描"这回事,
      // 它靠时间戳取胜,不该被当成某次扫描的产物。
      //
      // source 区分**我们是怎么知道的**:
      //   'server' = 看到了页面自己那个请求的响应(最硬)
      //   'page'   = 重新加载他的主页之后读到的状态(稍弱,但也是 X 自己说的)
      // 留着这个区别,是因为以后排查时"这条结论从哪来"是最先要看的东西。
      r.obs.iFollow[source || 'server'] = { v: !!following, at: when, seq: -1, complete: true };
      r.lastSeen = when;
      rel[id] = r;
      await set({ [KEYS.REL]: rel });
      return { ok: true };
    });
  }

  /** 工具自己执行过的动作也记进事件流,这样时间线是完整的 */
  async function recordEvent(type, id, sn, detail) {
    return withLock(async () => {
      const raw = await get([KEYS.EV]);
      const events = raw[KEYS.EV] || [];
      events.unshift({ ts: Date.now(), type, id, sn, detail: detail || {}, byTool: true });
      await set({ [KEYS.EV]: events.slice(0, MAX_EVENTS) });
    });
  }

  async function markUser(id, sn, patch) {
    return withLock(async () => {
      const raw = await get([KEYS.MARKS]);
      const marks = raw[KEYS.MARKS] || {};
      const cur = marks[id] || { sn, tags: [], note: '', markedAt: Date.now() };
      if (patch.remove) {
        delete marks[id];
      } else {
        marks[id] = Object.assign(cur, patch || {}, { sn: sn || cur.sn, updatedAt: Date.now() });
      }
      await set({ [KEYS.MARKS]: marks });
      return marks;
    });
  }

  /**
   * 白名单:正常的单向关注,不管了。
   * 加进去的人不会被算进统计,不会生成自动证据,也不会被批量动作选中 ——
   * 但仍然保留在关系表里,历史照旧记录(以后想撤出来随时可以)。
   */
  async function whitelistAdd(id, sn) {
    return withLock(async () => {
      const raw = await get([KEYS.WHITELIST]);
      const wl = raw[KEYS.WHITELIST] || {};
      wl[id] = { sn: sn || (wl[id] && wl[id].sn) || null, addedAt: Date.now() };
      await set({ [KEYS.WHITELIST]: wl });
      return wl;
    });
  }

  async function whitelistRemove(id) {
    return withLock(async () => {
      const raw = await get([KEYS.WHITELIST]);
      const wl = raw[KEYS.WHITELIST] || {};
      delete wl[id];
      await set({ [KEYS.WHITELIST]: wl });
      return wl;
    });
  }

  async function getQuota() {
    const raw = await get([KEYS.QUOTA]);
    return raw[KEYS.QUOTA] || null;
  }

  async function setQuota(q) {
    return withLock(async () => {
      await set({ [KEYS.QUOTA]: q });
      return q;
    });
  }

  /** 备份:本地版唯一的隐患是浏览器配置被清掉,所以导出必须是内置功能 */
  async function exportAll() {
    const state = await loadState();
    return {
      xfBackup: 2,
      exportedAt: Date.now(),
      config: state.config,
      relations: state.relations,
      events: state.events,
      marks: state.marks,
      whitelist: state.whitelist,
      stats: state.stats,
      snapshotOwner: state.snapshot ? state.snapshot.owner : null,
    };
  }

  /**
   * 导入。必须校验结构 —— 以前只检查 xfBackup===1,
   * 一个 `events:{}` 的坏备份能导入成功,之后 recordFollow 的 slice 才炸,
   * 而那时关注动作已经点下去了。
   *
   * 导入会**同时清掉两份快照**:导入的关系表和本机快照可能来自不同账号/时期,
   * 拿着旧快照去差分新关系表会产生一堆假事件。
   */
  async function importAll(obj) {
    if (!obj || (obj.xfBackup !== 1 && obj.xfBackup !== 2)) throw new Error('不是本工具的备份文件');
    const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (obj.relations != null && !isPlainObj(obj.relations)) throw new Error('relations 结构不合法');
    if (obj.marks != null && !isPlainObj(obj.marks)) throw new Error('marks 结构不合法');
    if (obj.whitelist != null && !isPlainObj(obj.whitelist)) throw new Error('whitelist 结构不合法');
    if (obj.events != null && !Array.isArray(obj.events)) throw new Error('events 必须是数组');
    if (obj.stats != null && !isPlainObj(obj.stats)) throw new Error('stats 结构不合法');

    return withLock(async () => {
      await remove([KEYS.SNAP, KEYS.SNAP_FOLLOWERS]);
      await set({
        [KEYS.REL]: obj.relations || {},
        [KEYS.EV]: obj.events || [],
        [KEYS.MARKS]: obj.marks || {},
        [KEYS.WHITELIST]: obj.whitelist || {},
        [KEYS.STATS]: Object.assign({ scans: 0, seqs: { following: 0, followers: 0 } }, obj.stats || {}),
      });
    });
  }

  async function clearAll() {
    return withLock(async () => {
      await remove([
        KEYS.SNAP,
        KEYS.SNAP_FOLLOWERS,
        KEYS.REL,
        KEYS.EV,
        KEYS.MARKS,
        KEYS.QUOTA,
        KEYS.STATS,
        KEYS.WHITELIST,
      ]);
    });
  }

  return {
    KEYS,
    DEFAULT_CONFIG,
    MAX_EVENTS,
    loadState,
    setConfig,
    recordScan,
    recordEvent,
    applyServerAction,
    markUser,
    whitelistAdd,
    whitelistRemove,
    getQuota,
    setQuota,
    exportAll,
    importAll,
    clearAll,
    // 供视图层推导用(纯函数)
    newRelation,
    ensureShape,
    applyObservation,
    mergeObservations,
  };
});
