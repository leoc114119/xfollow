// 从 X 的列表响应里抠出用户和关注关系标志。
//
// 这个模块重写过四次,前三次都在真机上失败,所以下面的每条规则都对应一次真实故障。
//
// ── 规则一:必须区分「列表条目」和「推荐模块里的用户」────────────────
// 整个响应里散落着各种用户对象(推荐位、可能认识的人、模块头)。第一版把它们一视同仁,
// 结果真机上「捕获 3 条」—— 那 3 个全是推荐账号,真正的列表条目一条都没进来。
// 现在的边界是**结构**的,不靠操作名猜:
//   · Tier A(可信,进正式名单)= timeline entries 数组里的**直接**元素,
//     且它带 user_results.result。这就是列表行。
//   · Tier B(仅诊断,不进名单)= 其它任何位置找到的用户,典型是 module 里的 items。
// 两级数量都报出来。Tier A 为空而 Tier B 一堆,就是"接口形状变了"的直接信号 ——
// 比静默产出一份错名单好得多。
//
// ── 规则二:字段级合并,一个字段缺了不影响别的字段 ──────────────
// X 把 User 拆开了:rest_id 在顶层,screen_name 在 core,legacy 正在被移除。
// 所以绝不能要求 id 和 screen_name 同层(那是第二次真机故障:条目全部漏掉)。
// 也绝不能让"某个来源缺 followed_by"阻断另一个来源提供它(第三次:假未知)。
// 做法是给每个对象排一个明确的来源优先级,然后**逐字段**取第一个有值的来源。
//
// ── 规则三:身份边界按显式结构判定,不把"没有不同的 id"当成同一个人 ──
// 解析某个列表条目时只在它自己的 core/legacy 等子对象里找字段,遇到 id 不同的节点就停。
// 列表主人挂在 data.user.result 上、条目挂在它的 timeline 里,条目是主人的后代 ——
// 不设这条边界,条目会继承到主人的关系标志,名单大面积错乱且毫无规律。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_DEPTH = 40;
  // 同一个用户身份内部找字段的深度上限。真实形状里 screen_name / 关系标志都在
  // core / legacy / relationship_perspectives 一层,3 层余量足够。
  const SAME_ID_DEPTH = 3;
  const MAX_SAMPLES = 4;

  const isBool = (v) => typeof v === 'boolean';

  function idOf(o) {
    if (typeof o.rest_id === 'string' && o.rest_id) return o.rest_id;
    if (typeof o.id_str === 'string' && o.id_str) return o.id_str;
    if (typeof o.id === 'string' && /^\d+$/.test(o.id)) return o.id;
    // 只认纯数字,避免把任意数值字段(计数、序号)当成用户身份
    if (typeof o.id === 'number' && Number.isInteger(o.id) && o.id > 0) return String(o.id);
    return null;
  }

  /**
   * 收集「属于同一个用户身份」的候选来源对象,并给出明确的优先级顺序。
   *
   * 关键点:遇到 id 不同的节点就停,不进去 —— 那是别人。
   * 注意不能反过来把"没有 id"当成"同一个人的一部分":无 id 的节点里也可能藏着
   * 另一个用户的字段。所以只有显式结构(core / legacy / relationship_perspectives)
   * 才被当作高优先级来源,无 id 的自由节点只当最后兜底,且要经过字段名白名单。
   */
  function gatherSources(node, id) {
    const sameId = (x) => {
      if (!x || typeof x !== 'object') return null;
      const xid = idOf(x);
      // 身份校验要在**取用之前**:以前把 core/legacy/rp 在检查 ID 前就存进候选,
      // 于是 rest_id:'1' 配 legacy:{id_str:'2'} 会把 2 的关系标志安到 1 头上。
      if (xid && xid !== id) return null;
      return x;
    };
    const core = sameId(node.core);
    const legacy = sameId(node.legacy);
    const rp = sameId(node.relationship_perspectives) || sameId(node.relationship_perspective);

    // 同身份的自由子节点(兜底)。跳过已知的三个,避免重复。
    const known = new Set([core, legacy, rp, node].filter(Boolean));
    const extras = [];
    const seen = new Set();
    const queue = [{ n: node, d: 0 }];
    while (queue.length) {
      const cur = queue.shift();
      const n = cur.n;
      if (!n || typeof n !== 'object' || cur.d > SAME_ID_DEPTH) continue;
      if (Array.isArray(n)) {
        for (const x of n) if (x && typeof x === 'object') queue.push({ n: x, d: cur.d + 1 });
        continue;
      }
      if (seen.has(n)) continue;
      seen.add(n);
      const nid = idOf(n);
      if (nid && nid !== id) continue; // 身份边界:别人的子树不进去
      if (!known.has(n)) extras.push(n);
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === 'object') queue.push({ n: v, d: cur.d + 1 });
      }
    }
    return { core, self: node, legacy, rp, extras };
  }

  /**
   * 逐字段解析一个用户。
   * 用户名优先级:core → 自身 → legacy → 兜底节点(自找 screen_name)。
   * 关系标志优先级:relationship_perspectives → 自身 → legacy → core → 兜底节点。
   * 两个字段**各自独立**取第一个有值的来源 —— 一个字段缺失不该把另一个也拖没。
   */
  function resolveUserFields(node, id) {
    const s = gatherSources(node, id);

    const snSources = [
      ['core.screen_name', s.core],
      ['screen_name', s.self],
      ['legacy.screen_name', s.legacy],
    ];
    for (const e of s.extras) snSources.push(['(嵌套)screen_name', e]);

    let sn = null;
    let snVia = null;
    for (const [label, src] of snSources) {
      if (!src) continue;
      if (typeof src.screen_name === 'string' && src.screen_name) {
        sn = src.screen_name;
        snVia = label;
        break;
      }
    }

    const flagSources = [
      ['relationship_perspectives', s.rp],
      ['followed_by', s.self],
      ['legacy.followed_by', s.legacy],
      ['core.followed_by', s.core],
    ];
    for (const e of s.extras) flagSources.push(['(嵌套)followed_by', e]);

    let fb;
    let fbVia = null;
    let f;
    for (const [label, src] of flagSources) {
      if (!src) continue;
      // 只有用户对象自己、显式带 relationship_perspectives 的对象、
      // 或者已知的 core/legacy,才有资格提供裸布尔标志。
      const eligible = label !== '(嵌套)followed_by' || !!(idOf(src) || src.screen_name);
      if (!eligible) continue;
      if (fb === undefined && isBool(src.followed_by)) {
        fb = src.followed_by;
        fbVia = `${label}.followed_by`;
      }
      if (f === undefined && isBool(src.following)) f = src.following;
    }

    // 蓝标。注意两个字段不是一回事:
    //   is_blue_verified = 付费蓝标(现在大家在说的"蓝V")
    //   verified         = 旧的认证标记,大部分账号已失效
    // 只认前者。读不到就留 undefined,让上层标成"未知",不要拿旧字段冒充。
    const blueSources = [['is_blue_verified', s.self], ['core.is_blue_verified', s.core], ['legacy.is_blue_verified', s.legacy]];
    for (const e of s.extras) blueSources.push(['(嵌套)is_blue_verified', e]);
    let blueV;
    let blueVVia = null;
    for (const [label, src] of blueSources) {
      if (!src) continue;
      if (blueV === undefined && isBool(src.is_blue_verified)) {
        blueV = src.is_blue_verified;
        blueVVia = label;
      }
    }
    let verifiedLegacy;
    for (const [label, src] of [['verified', s.self], ['legacy.verified', s.legacy], ['core.verified', s.core]]) {
      if (!src) continue;
      if (verifiedLegacy === undefined && isBool(src.verified)) {
        verifiedLegacy = src.verified;
        break;
      }
    }

    // 头像。纯粹为了界面上能认人 —— 一整列纯文字块是最难扫读的。
    // 只认 https 的 profile_image_url_https,拿不到就留 undefined,
    // 由界面用首字母圆兜底(不要回落到 http 的 profile_image_url,那会混进混合内容)。
    const avatarSources = [['profile_image_url_https', s.self], ['core.profile_image_url_https', s.core], ['legacy.profile_image_url_https', s.legacy]];
    for (const e of s.extras) avatarSources.push(['(嵌套)profile_image_url_https', e]);
    let avatar;
    for (const [, src] of avatarSources) {
      if (!src) continue;
      const u = src.profile_image_url_https;
      if (avatar === undefined && typeof u === 'string' && /^https:\/\//.test(u)) {
        avatar = u; // 原样存下来;要显示多大是界面的事,不在数据层重写 URL
        break;
      }
    }

    return { sn, snVia, fb, fbVia, f, blueV, blueVVia, verifiedLegacy, avatar };
  }

  /** 从 timeline 条目里取用户对象。条目本身、content、itemContent 三种包装层都兜住。 */
  function entryUserResult(...cands) {
    for (const c of cands) {
      if (!c || typeof c !== 'object') continue;
      for (const x of [c, c.content, c.itemContent]) {
        if (!x || typeof x !== 'object') continue;
        const ur = x.user_results;
        if (ur && typeof ur === 'object' && ur.result && typeof ur.result === 'object') return ur.result;
      }
    }
    return null;
  }

  function collectCursors(root, out) {
    walkAll(root, (o) => {
      if (typeof o.cursorType === 'string' && typeof o.value === 'string' && o.value) {
        if (o.cursorType === 'Bottom') out.bottom = o.value;
        if (o.cursorType === 'Top') out.top = o.value;
      }
      const nc = o.next_cursor;
      if (typeof nc === 'string' && nc) out.nextCursor = nc;
      else if (typeof nc === 'number' && Number.isFinite(nc) && nc !== 0) out.nextCursor = String(nc);
      // next_cursor 为 0 / '0' 是 1.1 表示"没有下一页"的约定
      if (nc === 0 || nc === '0') out.atEnd = true;
    });
  }

  function walkAll(node, visit, depth) {
    const d = depth || 0;
    if (!node || typeof node !== 'object' || d > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walkAll(item, visit, d + 1);
      return;
    }
    visit(node, d);
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') walkAll(v, visit, d + 1);
    }
  }

  function makeStats() {
    return {
      entriesSeen: 0,
      tierA: 0,
      tierB: 0,
      cursorEntries: 0,
      modules: 0,
      entriesWithoutUser: 0,
      itemTypes: {},
      entryIdPrefixes: {},
    };
  }

  function bump(map, key) {
    const k = key || '(空)';
    map[k] = (map[k] || 0) + 1;
  }

  /**
   * 主收集器。
   * 返回 { users(tier A), suspects(tier B), owner, stats, samples }
   */
  function collectUsers(root) {
    const tierA = new Map();
    const tierB = new Map();
    const claimed = new Set(); // 已被认领为列表条目的用户对象,别再当可疑项重复统计
    const stats = makeStats();
    const samples = [];
    let owner = null;

    function addTo(map, rec) {
      const prev = map.get(rec.id);
      if (!prev) {
        map.set(rec.id, rec);
        return;
      }
      // 同一个 id 可能来自多个来源(同一条目的不同包装层)。逐字段补齐,不整条覆盖。
      if ((prev.sn === null || prev.sn === undefined) && rec.sn) prev.sn = rec.sn;
      if (prev.fb === null && rec.fb !== null) prev.fb = rec.fb;
      if (prev.f === null && rec.f !== null) prev.f = rec.f;
      // 蓝标同理:已经读到的值不该被另一个包装层的"未知"盖掉
      if (prev.blueV === null && rec.blueV !== null) prev.blueV = rec.blueV;
      if (!prev.avatar && rec.avatar) prev.avatar = rec.avatar;
    }

    const mkRec = (id, f) => ({
      id,
      sn: f.sn,
      fb: f.fb === undefined ? null : f.fb,
      f: f.f === undefined ? null : f.f,
      blueV: f.blueV === undefined ? null : f.blueV,
      avatar: f.avatar || null,
    });

    function claimEntry(e, ctx) {
      if (!e || typeof e !== 'object') return;
      stats.entriesSeen++;
      const entryId = typeof e.entryId === 'string' ? e.entryId : '';
      bump(stats.entryIdPrefixes, entryId.split('-')[0]);
      return entryId;
    }

    function handleEntry(e, ctx) {
      const entryId = claimEntry(e, ctx);
      if (entryId === undefined) return;
      const content = e.content;
      if (content && typeof content === 'object') {
        // module 里的用户是 Tier B(推荐位之类),这里直接交回给通用遍历,
        // 不当作列表行,也不计入"条目里没有用户"的统计。
        if (content.entryType === 'TimelineTimelineModule') {
          stats.modules++;
          return;
        }
        const t = content.itemType || (content.itemContent && content.itemContent.itemType);
        if (t) bump(stats.itemTypes, t);
      }
      // 把条目本身也传进去:某些形状下 itemContent 直接挂条目上,没有 content 包装层
      const res = entryUserResult(content, e);
      if (!res) {
        // 游标条目不是用户,正常
        if (content && /Cursor/i.test(String(content.entryType || ''))) stats.cursorEntries++;
        else stats.entriesWithoutUser++;
        return;
      }
      const id = idOf(res);
      if (!id) return;
      const f = resolveUserFields(res, id);
      if (!f.sn) {
        stats.entriesWithoutUser++;
        return;
      }
      claimed.add(res);
      addTo(tierA, mkRec(id, f));
      stats.tierA++;
      if (samples.length < MAX_SAMPLES) {
        samples.push({
          tier: 'A',
          id,
          sn: f.sn,
          snVia: f.snVia,
          flagVia: f.fbVia,
          fb: f.fb,
          f: f.f,
          blueV: f.blueV,
          blueVVia: f.blueVVia,
          entryId,
        });
      }
      // 列表主人 = 包含这些条目的那个用户祖先
      if (!owner && ctx && ctx.userId && ctx.handle) owner = { id: ctx.userId, handle: ctx.handle };
    }

    // 递归遍历。ctx 携带"最近的用户祖先",用来给条目绑定 owner。
    function visit(node, ctx, depth, viaInstructions) {
      if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
      if (Array.isArray(node)) {
        // viaInstructions 必须往数组元素上继续传,否则 instructions[] 的元素拿不到这个标记
        for (const it of node) visit(it, ctx, depth + 1, viaInstructions);
        return;
      }

      let childCtx = ctx;
      const selfId = idOf(node);
      if (selfId) {
        // 找一个能当"用户名"的字段,作为 owner 的 handle
        const s = gatherSources(node, selfId);
        const handle =
          (s.core && s.core.screen_name) ||
          node.screen_name ||
          (s.legacy && s.legacy.screen_name) ||
          null;
        childCtx = { userId: selfId, handle: handle || (ctx && ctx.handle) || null, node };
      }

      // timeline 的 entries 容器:这里的**直接**元素才是列表行。
      // 必须绑定到"目标 timeline"——以前任意深度的 node.entries 都会被当成列表,
      // 于是 {recommendations:{entries:[...]}} 这种结构里的推荐位用户也进了正式名单。
      // 两个信号:指令节点自带 type:'TimelineAddEntries',或者它本身是 instructions 的元素。
      const looksLikeTimeline = (typeof node.type === 'string' && /^Timeline/i.test(node.type)) || viaInstructions;
      if (Array.isArray(node.entries) && looksLikeTimeline) {
        for (const e of node.entries) handleEntry(e, childCtx);
      }

      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') {
          // 传给子节点的标记:我是从一个带 instructions 数组的节点下来的
          visit(v, childCtx, depth + 1, k === 'instructions' ? true : viaInstructions);
        }
      }
    }

    visit(root, null, 0, false);

    // 1.1 的扁平形状:根就是 { users: [...] }。直接元素即列表行。
    if (Array.isArray(root.users)) {
      for (const u of root.users) {
        if (!u || typeof u !== 'object') continue;
        const id = idOf(u);
        if (!id) continue;
        const f = resolveUserFields(u, id);
        if (!f.sn) continue;
        claimed.add(u);
        addTo(tierA, mkRec(id, f));
        stats.tierA++;
        if (samples.length < MAX_SAMPLES) {
          samples.push({
            tier: 'A',
            id,
            sn: f.sn,
            snVia: f.snVia,
            flagVia: f.fbVia,
            fb: f.fb,
            f: f.f,
            blueV: f.blueV,
            blueVVia: f.blueVVia,
            entryId: '(1.1 users[])',
          });
        }
      }
    }

    // Tier B:其余位置的用户对象。只做诊断,不进正式名单。
    walkAll(root, (node) => {
      if (Array.isArray(node) || claimed.has(node)) return;
      const id = idOf(node);
      if (!id || tierA.has(id)) return; // 已经是正式条目了
      const f = resolveUserFields(node, id);
      if (!f.sn) return;
      addTo(tierB, mkRec(id, f));
      stats.tierB++;
      if (samples.length < MAX_SAMPLES + 2) {
        samples.push({ tier: 'B', id, sn: f.sn, snVia: f.snVia, flagVia: f.fbVia, fb: f.fb, f: f.f, entryId: null });
      }
    });

    return { tierA, tierB, owner, stats, samples };
  }

  // 从 URL 判断这是谁的哪张列表。
  function classifyUrl(url) {
    const u = String(url || '');
    if (/\/1\.1\/friends\/list\.json/i.test(u) || /\/graphql\/[^/]*\/Following/i.test(u)) {
      return 'following';
    }
    if (/\/1\.1\/followers\/list\.json/i.test(u) || /\/graphql\/[^/]*\/Followers/i.test(u)) {
      return 'followers';
    }
    if (/Follow(ing|ers)/i.test(u)) return /Followers/i.test(u) ? 'followers' : 'following';
    return null;
  }

  /**
   * 入口。jsonText 是 X 应用自己拿到的原始响应体,我们只是读它,没有发任何请求。
   * selfHandle 用来剔掉"列表主人自己"—— 它总会被收进来,不出掉会多一行。
   */
  function extract(jsonText, url, selfHandle) {
    const result = {
      listType: classifyUrl(url),
      users: [], // Tier A only
      owner: null,
      /** Tier B 的数量。Tier A 为 0 而它不为 0,就是接口形状变了的信号。 */
      suspects: 0,
      suspectNames: [],
      cursors: { bottom: null, top: null, nextCursor: null, atEnd: false },
      /** 正式条目里到底有没有 followed_by —— 这是整个工具成立与否的命门 */
      flagsAvailable: false,
      stats: makeStats(),
      samples: [],
      parseError: null,
    };

    let root;
    try {
      root = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    } catch (e) {
      result.parseError = String(e && e.message ? e.message : e);
      return result;
    }
    if (!root || typeof root !== 'object') return result;

    const { tierA, tierB, owner, stats, samples } = collectUsers(root);
    collectCursors(root, result.cursors);
    // 拿到了条目却没有任何游标 ⇒ 这是最后一页。
    // 1.1 会用 next_cursor=0 明确表示"没有下一页",GraphQL 不给这个信号;
    // 不补这一条的话扫描永远无法确认"到底了",每次都会被判成不完整。
    if (tierA.size > 0 && !result.cursors.bottom && !result.cursors.nextCursor) {
      result.cursors.atEnd = true;
    }
    result.stats = stats;
    result.samples = samples;
    result.owner = owner;

    const self = selfHandle ? String(selfHandle).replace(/^@/, '').toLowerCase() : null;
    for (const rec of tierA.values()) {
      // 列表主人不是自己名单里的成员
      if (owner && rec.id === owner.id) continue;
      if (self && rec.sn.toLowerCase() === self) continue;
      if (rec.fb !== null) result.flagsAvailable = true;
      result.users.push(rec);
    }

    // 疑似的推荐/模块用户:只计数和留名字,绝不进名单
    for (const rec of tierB.values()) {
      if (tierA.has(rec.id)) continue;
      if (owner && rec.id === owner.id) continue;
      if (self && rec.sn.toLowerCase() === self) continue;
      result.suspects++;
      if (result.suspectNames.length < 8) result.suspectNames.push(rec.sn);
    }

    return result;
  }

  return {
    extract,
    classifyUrl,
    collectUsers,
    collectCursors,
    resolveUserFields,
    gatherSources,
    _internal: { walkAll, idOf, entryUserResult },
  };
});
