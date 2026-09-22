// 快照差分。纯函数,不碰存储、不碰网络 —— 这样差分逻辑可以用构造数据完整覆盖。
//
// 设计前提:只扫"我自己关注的人"这一张列表就够了。因为每个条目都带 followed_by
// (他是否关注我),一次扫描同时得到:
//   · 未回关   = 我关注着他 且 followed_by=false
//   · 已回关   = followed_by=true
//   · 他取关我 = 两次快照对比 followed_by 从 true 翻成 false  ← 骗关注最硬的证据
// 只有"谁取关了我"需要第二份快照,其余第一份就够。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 事件类型
  const EV = {
    // ── 关注列表(我关注的人)上的变化 ──────────────────────
    UNFOLLOWED_ME: 'unfollowed_me', // 他取关了我
    FOLLOWED_ME: 'followed_me', // 他开始关注我
    DROPPED: 'dropped', // 从我的关注列表消失
    NEW: 'new', // 我的关注列表里新出现
    // ── 粉丝列表(关注我的人)上的变化 ──────────────────────
    NEW_FOLLOWER: 'new_follower', // 新粉丝
    LOST_FOLLOWER: 'lost_follower', // 曾经关注我、现在不关注了 —— 渣蓝管理的核心信号
    I_FOLLOWED: 'i_followed', // 我回关了他
    I_UNFOLLOWED: 'i_unfollowed', // 我取关了他
  };

  // 列表类型决定了"哪个标志才是有效信号":
  //   我的关注列表里  → 每条的 followed_by 告诉我"他回关我了吗"
  //   我的粉丝列表里  → 每条的 following   告诉我"我回关他了吗"
  // 两个标志在两张列表上都能读到,但只有一个是变化的那个。
  const EV_LABEL = {
    [EV.UNFOLLOWED_ME]: '他取关了我',
    [EV.FOLLOWED_ME]: '他开始关注我',
    [EV.DROPPED]: '掉出关注列表',
    [EV.NEW]: '新出现在关注列表',
    [EV.NEW_FOLLOWER]: '新粉丝',
    [EV.LOST_FOLLOWER]: '他取关了我(原粉丝)',
    [EV.I_FOLLOWED]: '我回关了他',
    [EV.I_UNFOLLOWED]: '我取关了他',
  };

  // 提取器版本。改了提取逻辑就要 +1 —— 跨版本比较两份快照会产生大量假事件
  // (旧快照里的 followed_by 是错的,新的一比就变成"他刚取关我")。
  // v1 → 初版;v2 → 修跨身份继承;v3 → 支持 core.screen_name;
  // v4 → 区分列表条目与推荐模块,字段级合并;v5 → 支持粉丝列表与蓝标;
  // v6 → 关系表改观测模型 + 快照带归属验证标记。
  const SNAPSHOT_VERSION = 6;

  function buildSnapshot({ ts, listType, owner, ownerId, ownerVerified, cap, truncated, scanned, order, entries }) {
    return {
      v: SNAPSHOT_VERSION,
      ts: ts || Date.now(),
      listType: listType || 'following',
      owner: owner || null,
      // 账号身份。差分只允许和同一个账号的快照比较 ——
      // 只比提取器版本不够:A 账号的 followed_by:true 和 B 账号的 false 一比,
      // 就会生成"他取关了我",而这两份描述的不是同一个关系。
      ownerId: ownerId || null,
      // 归属有没有经过验证(侧边栏读到身份才算)。没验证的数据可以看,但不许据此写操作。
      ownerVerified: !!ownerVerified,
      cap: cap || 0,
      // 是否因为撞到 cap 提前停了。截断的快照不能用来判断"掉出列表",
      // 因为掉出去的可能只是被 1000 条上限挤掉了,不是关系变化。
      truncated: !!truncated,
      scanned: scanned || 0,
      order: order || [],
      entries: entries || {},
    };
  }

  /**
   * 比较两份 entry 映射,产出一批事件。
   * @param prev 上一份 entries  { [id]: {sn, fb, f, blueV} }
   * @param cur  这一份 entries
   * @param opts.listType      'following' | 'followers' —— 决定哪个标志才是有效信号
   * @param opts.followedAt    { [id]: ts } 可选,首次记录时间
   * @param opts.prevTruncated 上一份是否被上限/中断截断
   * @param opts.curIncomplete 本次是否不完整(被中断、或没能确认扫到底)。
   *        **这个方向以前检查错了**:旧版只看 prevTruncated,于是"上一次完整、
   *        这一次手动停止"时,没加载到的账号会被确定地记成"掉出列表"。
   *        本次没观测到 ≠ 关系发生变化 —— 两个方向都要看。
   */
  function diffEntries(prev, cur, opts = {}) {
    const out = [];
    // prev 为 null 表示"没有基线",不是"基线是空的"。
    // 这时所有人都是第一次见到,不该报成"新出现在列表" —— 否则第一次扫描
    // 会刷出一整屏假事件,把真正的事件淹没。
    // 注意区分:prev 传 {} 是"基线确实是空的",那种情况才该全部报 new。
    if (prev == null) return out;

    const ts = opts.ts || Date.now();
    const listType = opts.listType === 'followers' ? 'followers' : 'following';
    const prevEntries = prev || {};
    const curEntries = cur || {};
    const followedAt = opts.followedAt || {};
    const prevTruncated = !!opts.prevTruncated;
    const curIncomplete = !!opts.curIncomplete;
    const uncertain = prevTruncated || curIncomplete;

    for (const id of Object.keys(curEntries)) {
      const c = curEntries[id];
      const p = prevEntries[id];
      if (!p) {
        out.push({
          ts,
          type: listType === 'followers' ? EV.NEW_FOLLOWER : EV.NEW,
          id,
          sn: c.sn,
          detail: { fb: c.fb, f: c.f, blueV: c.blueV, uncertain: prevTruncated },
        });
        continue;
      }
      if (listType === 'followers') {
        // 粉丝列表上有效的是 following:"我回关他了吗"
        if (p.f === false && c.f === true) {
          out.push({ ts, type: EV.I_FOLLOWED, id, sn: c.sn, detail: { blueV: c.blueV } });
        } else if (p.f === true && c.f === false) {
          out.push({ ts, type: EV.I_UNFOLLOWED, id, sn: c.sn, detail: { blueV: c.blueV } });
        }
      } else {
        // 关注列表上有效的是 followed_by:"他回关我了吗"
        if (p.fb === true && c.fb === false) {
          const since = followedAt[id];
          out.push({
            ts,
            type: EV.UNFOLLOWED_ME,
            id,
            sn: c.sn,
            detail: { firstRecordDays: since ? Math.round((ts - since) / 86400000) : null, blueV: c.blueV },
          });
        } else if (p.fb === false && c.fb === true) {
          out.push({ ts, type: EV.FOLLOWED_ME, id, sn: c.sn, detail: { blueV: c.blueV } });
        }
      }
    }

    for (const id of Object.keys(prevEntries)) {
      if (curEntries[id]) continue;
      const p = prevEntries[id];
      out.push({
        ts,
        type: listType === 'followers' ? EV.LOST_FOLLOWER : EV.DROPPED,
        id,
        sn: p.sn,
        detail: {
          // 任意一侧不完整,就说不清他是真掉出去了还是只是没被读到
          uncertain,
          lastFb: p.fb,
          lastF: p.f,
          blueV: p.blueV,
          // 粉丝列表上还要记下"我当时有没有回关他" ——
          // "你回关了他、他随后取关你"正是骗关注的典型形态
          iFollowedAtLoss: listType === 'followers' ? p.f === true : undefined,
        },
      });
    }

    return out;
  }

  /** 统计一份快照里未回关 / 已回关各多少。只对关注列表有意义。 */
  function summarize(entries) {
    let noBack = 0;
    let back = 0;
    let unknown = 0;
    for (const id of Object.keys(entries || {})) {
      const e = entries[id];
      if (e.fb === true) back++;
      else if (e.fb === false) noBack++;
      else unknown++;
    }
    return { total: Object.keys(entries || {}).length, noBack, back, unknown };
  }

  return { EV, EV_LABEL, SNAPSHOT_VERSION, buildSnapshot, diffEntries, summarize };
});
