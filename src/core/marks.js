// 三个名单的数据来源。纯本地 —— 不上传任何地方。
//
// ══ 两个维度 ══════════════════════════════════════════════════
//   iFollow   = 我关注他吗     ← 关注列表里有没有他 / 粉丝列表给的 following
//   heFollows = 他关注我吗     ← 粉丝列表里有没有他 / 关注列表给的 followed_by
//
// 三个名单就是这两个维度加上历史:
//   回关检测   = heFollows && !iFollow && 蓝V    (他在等我回关,而且是蓝V)
//   未回关检查 = iFollow   && !heFollows         (我关注他、他不回关 —— 含取关过我的)
//   渣蓝管理   = 曾经关注过我、现在不关注         (heStoppedAt,历史事实)
//
// 一条容易写错、错了会害人的规则:**最新的观测胜出**,不搞"true 优先"。
// 固定偏向 true 会让新的否定永远盖不过旧的肯定:我先关注了他、他取关我、我再取关他 ——
// 结果他还永久留在"未回关"名单里。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY = 86400000;

  /**
   * 从一个事实的多个来源观测里得出当前值。
   * 最新观测胜出;时间相同时,完整扫描的观测优先。
   * fresh = 这条观测来自该来源最近一次扫描(也就是"本轮覆盖到了")。
   */
  function resolveFact(slots, seqs) {
    const list = [];
    for (const src of Object.keys(slots || {})) {
      const o = slots[src];
      if (!o || typeof o.v !== 'boolean' || o.at == null) continue;
      list.push({ src, v: o.v, at: o.at, seq: o.seq == null ? -1 : o.seq, complete: !!o.complete });
    }
    if (!list.length) return { value: null, fresh: false, at: null, source: null };
    list.sort((a, b) => b.at - a.at || Number(b.complete) - Number(a.complete) || b.seq - a.seq);
    const w = list[0];
    return {
      value: w.v,
      at: w.at,
      source: w.src,
      complete: w.complete,
      fresh: !!(seqs && seqs[w.src] != null && seqs[w.src] === w.seq),
    };
  }

  /** 某个来源本轮有没有覆盖到这个人(有该来源、且序号等于该来源最新序号的观测) */
  function sourceFresh(slotsList, source, seqs) {
    if (!seqs || !seqs[source]) return false;
    for (const slots of slotsList) {
      const o = slots && slots[source];
      if (o && o.seq === seqs[source]) return true;
    }
    return false;
  }

  /**
   * 他关注了我多久之后取关的(天)。
   *
   * 间隔必须用**观测到的建立时刻**算。首次看到就是 true 不算建立 ——
   * 那只能证明"那时他关注我",拿它当起点会冤枉互关多年的老账号。
   */
  function unfollowSpanDays(rel) {
    const r = rel || {};
    if (!r.heStoppedAt || !r.observedHeFollowStartAt) return null;
    if (r.heStoppedAt < r.observedHeFollowStartAt) return null;
    return Math.round((r.heStoppedAt - r.observedHeFollowStartAt) / DAY);
  }

  /** 给界面用的行 */
  function buildRows(state, opts = {}) {
    const now = opts.nowTs || Date.now();
    const seqs = (state.stats && state.stats.seqs) || { following: 0, followers: 0 };
    // 归属没验证过的数据可以看,但要能显示出来 —— 那可能把别人当成自己。
    const trusted = !!(
      state.trusted === true ||
      (state.snapshot && state.snapshot.ownerVerified) ||
      (state.snapshotFollowers && state.snapshotFollowers.ownerVerified) ||
      (state.stats && (state.stats.ownerVerified || (state.stats.followers && state.stats.followers.ownerVerified)))
    );

    const rows = [];
    const ids = new Set([...Object.keys(state.relations), ...Object.keys(state.marks || {})]);

    for (const id of ids) {
      const r = state.relations[id] || {};
      const obs = r.obs || { iFollow: {}, heFollows: {} };
      const iF = resolveFact(obs.iFollow, seqs);
      const hF = resolveFact(obs.heFollows, seqs);
      const wl = (state.whitelist || {})[id] || null;

      rows.push({
        id,
        sn: (wl && wl.sn) || r.sn || id,
        avatar: r.avatar || null,
        // 三种状态要分得开:true=是蓝V,false=不是,null=读不到。
        // 把"读不到"和"不是"混起来会让蓝V名单静默漏人。
        blueV: typeof r.blueV === 'boolean' ? r.blueV : null,
        iFollow: iF.value,
        iFollowAt: iF.at,
        heFollows: hF.value,
        followingFresh: sourceFresh([obs.iFollow, obs.heFollows], 'following', seqs),
        followersFresh: sourceFresh([obs.iFollow, obs.heFollows], 'followers', seqs),
        heStoppedAt: r.heStoppedAt || null,
        heStoppedVia: r.heStoppedVia || null,
        heStoppedCount: r.heStoppedCount || 0,
        unfollowSpanDays: unfollowSpanDays(r),
        firstSeen: r.firstSeen || null,
        firstSeenDays: r.firstSeen ? Math.round((now - r.firstSeen) / DAY) : null,
        whitelisted: !!wl,
        whitelistedAt: wl ? wl.addedAt : null,
        trusted,
      });
    }
    return rows;
  }

  // ── 三个名单 ────────────────────────────────────────────────
  // 纯筛选,不认识任何"动作"。

  // ── 名单只看"最近一次扫描覆盖到的人" ──────────────────────
  //
  // 为什么必须加这个约束(真机踩过):
  // 关系是**累积**记下来的,所以上限还是 1000 那时候扫进来的人,只要关系没被推翻
  // 就永远留在名单里。而现在每次只扫最新 200 个、又因为"不完整"做不了"谁不在名单里"
  // 那种减量推断 —— 结果新的进不来、旧的出不去,名单看起来就是"好久以前的",
  // 而且再扫也一动不动。
  //
  // 加上 fresh 之后语义才和需求对上:"最近 200 个里,谁没回关我"。
  // 没被这轮扫到的人不再出现在名单上 —— 他们的状态是旧的,不该拿来当现状。

  /** 回关检测:他关注了我,我还没回关(只算最近一次粉丝列表扫到的人) */
  function fansNotFollowedBack(rows) {
    return rows.filter((r) => r.heFollows === true && r.followersFresh && r.iFollow === false);
  }

  /** 未回关检查:我关注了他,他没回关我(只算最近一次关注列表扫到的人) */
  function notFollowingBack(rows) {
    return rows.filter((r) => r.iFollow === true && r.followingFresh && r.heFollows === false);
  }

  /**
   * 渣蓝管理:曾经关注过我,后来不关注了。
   *
   * 但**已经被我处理过的不再列出来** —— 否则取关完他还挂在名单上,看不出做过什么。
   * "处理过" = 他取关我之后,我也取关了他(iFollow 变成 false,而且那次观测比
   * heStoppedAt 更晚)。用时间比而不是只看当前值:如果只是"我本来就没关注他",
   * 那不是处理过,不该消失。
   */
  function unfollowedMe(rows) {
    return rows.filter((r) => {
      if (!r.heStoppedAt) return false;
      if (r.iFollow !== false) return true;
      return !(r.iFollowAt && r.iFollowAt > r.heStoppedAt);
    });
  }

  /** 白名单:标成"正常的单向关注"的人 */
  function whitelisted(rows) {
    return rows.filter((r) => r.whitelisted);
  }

  /** 确定是蓝V的 */
  function blueVOnly(rows) {
    return rows.filter((r) => r.blueV === true);
  }

  /**
   * 蓝V读不到的。
   * 单独数出来是为了**不让它们静默消失** —— 蓝V名单只收确定的,
   * 但界面上要说一句"另有 N 人蓝V未知",否则人少了却看不出为什么。
   */
  function blueVUnknown(rows) {
    return rows.filter((r) => r.blueV === null);
  }

  /** 三个名单各自该显示的完整行(已经排除忽略的) */
  function viewRows(rows, tab) {
    const pool = rows.filter((r) => !r.whitelisted);
    if (tab === 'fans') return blueVOnly(fansNotFollowedBack(pool));
    if (tab === 'noback') return notFollowingBack(pool);
    return unfollowedMe(pool);
  }

  return {
    DAY,
    resolveFact,
    sourceFresh,
    unfollowSpanDays,
    buildRows,
    fansNotFollowedBack,
    notFollowingBack,
    unfollowedMe,
    whitelisted,
    blueVOnly,
    blueVUnknown,
    viewRows,
  };
});
