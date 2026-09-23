// 侧边栏 —— 全部界面都在这里。
//
// 设计原则(和这次精简的方向一致):
//   1. **只显示名单**。工具不替你关注、不替你取关。点一行 = 开他的主页(新标签页),
//      你在 X 自己的界面上动手。这不是妥协 —— X 自己的关注按钮就在那一页上,
//      而且由它自己发出去的请求永远不会踩签名和限流那套检测。
//   2. 每行只回答两个问题:他是谁、他和我现在是什么关系。其余都是噪音。
//   3. 渲染出错必须写在页面上。上一版踩过"点开是一片空白,原因只躺在控制台里"。
//
// 三个名单的口径在 core/marks.js 里,这里只负责显示。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 命名空间在加载时抓一次,之后一直用这个引用。
  //
  // 为什么不每次读 globalThis.XF:**它不一定读得到**。踩过两次 ——
  //   · DOM 事件回调里,globalThis 不保证还是同一个 realm(jsdom 下就不是),
  //     于是回调里读到 undefined,表现是"点一下没反应"
  //   · 模块被 node require 时走的是 module.exports 分支,根本没有命名空间可读
  // 抓一次 + 兜底,两种情况都与它无关了。
  let NS = globalThis.XF || null;
  function ns() {
    if (!NS) NS = globalThis.XF || (typeof window !== 'undefined' && window.XF) || null;
    return NS || {};
  }
  const B = ns(); // bridge / scan / ledger / marks 都挂在这个命名空间上

  const TITLE = 'xfollow - 拒绝渣蓝';
  // 收起时把手上的字。**竖着一个字母一行** —— 把手只有 36px 宽。
  const HANDLE_TEXT = 'XFOLLOW';
  // 作者主页:使用反馈请关注。这是工具里唯一的对外链接,也是用户自己要求的。
  const AUTHOR_URL = 'https://x.com/leo114119';
  const CAP = 200;
  const TAB_KEY = 'xf:activeTab';

  const TABS = [
    { key: 'fans', label: '回关检测', hint: '关注了你、是蓝V,你还没回关' },
    { key: 'noback', label: '未回关', hint: '你关注了、但没回关你的人(含后来取关你的)' },
    { key: 'sway', label: '渣蓝', hint: '曾经关注过你、后来不关注了' },
  ];

  // 每个名单要看哪张列表 —— 决定「扫描」按钮扫的是哪一个
  // 每个名单要看哪张列表。
  //
  // 渣蓝看**粉丝列表**,而且这次要**扫到底**:
  // 「他取关了你」有两种情形,可检测性完全不同 ——
  //   ① 你关注过的人取关了你:响应里的 followed_by 从 true 变 false,反复扫关注列表就能发现
  //   ② 从没回关过你的人取关了你(典型的骗关注):要发现的事实是"**他不在名单里了**",
  //      而"不在"只能靠完整名单推出来 —— 所以必须扫到底,不能只扫最近 200 个
  // ② 才是这个功能存在的理由,所以渣蓝扫粉丝列表并且不设上限。
  const LIST_FOR_TAB = { fans: 'followers', noback: 'following', sway: 'followers' };
  /** 这张名单的扫描要不要"扫到底"(不限量) */
  const FULL_SCAN = { fans: false, noback: false, sway: true };
  // 每个名单的主操作。名字即动作 —— 见 renderRow 里的说明。
  const ACTION_OF_TAB = {
    fans: { kind: 'follow', label: '关注', verb: '关注' },
    noback: { kind: 'unfollow', label: '取关', verb: '取关' },
    sway: { kind: 'unfollow', label: '取关', verb: '取关' },
  };
  const LIST_LABEL = { following: '关注列表', followers: '粉丝列表' };

  let rootEl = null;
  let state = null;
  let rows = [];
  let activeTab = 'fans';
  let open = false;
  let busy = null;
  let showIgnored = false;
  // 后台执行器的进度/结果。一句话就够 —— 这是"你可以走开一会儿"的反馈。
  let scanError = null; // 上一次扫描失败的原因 —— 存在状态里,不然会被重绘冲掉
  let lastAction = null; // 上一次扫描的结果(落盘的)—— 跳转之后只有它能说明发生了什么
  let lastByList = null; // 每张列表各自最近一次扫到什么 —— 只留一张会让排查失去依据
  let lockInfo = null; // { reason, minutesLeft } —— 熔断时用来显示倒计时和「解除」
  let jobMsg = null;
  let jobBusy = false;

  // ── 小工具 ──────────────────────────────────────────────────
  const $ = (sel) => (rootEl ? rootEl.querySelector(sel) : null);

  function esc(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function alive() {
    return typeof ns().chromeAlive === 'function' ? ns().chromeAlive() : true;
  }

  /** 分段耗时压成一小段 —— 够看出"慢在哪一步",又不至于刷屏 */
  function fmtTimings(t) {
    if (!t) return '';
    const parts = [];
    if (t.ready != null) parts.push(`等到按钮 ${Math.round(t.ready / 1000)}s`);
    if (t.clickToResult != null) parts.push(`点完到结论 ${Math.round(t.clickToResult / 1000)}s`);
    return parts.length ? ` · 耗时 ${parts.join(' / ')}` : '';
  }

  /** 相对时间。数字比日期好读:"3 天前"比 "2026-09-18" 更容易下判断。 */
  function ago(ts) {
    if (!ts) return '';
    const d = Math.round((Date.now() - ts) / 86400000);
    if (d < 0) return '今天'; // 时钟偏差或脏数据,别显示"负几天前"
    if (d === 0) return '今天';
    if (d === 1) return '昨天';
    if (d < 30) return d + ' 天前';
    const m = Math.round(d / 30);
    if (m < 12) return m + ' 个月前';
    // 超过一年就别再说"N 年前"了 —— 真的碰到过脏数据被显示成"58 年前",
    // 那种话一眼就是坏的,不如直接给日期
    const dt = new Date(ts);
    const y = dt.getFullYear();
    if (m < 18) return `去年 ${dt.getMonth() + 1} 月`;
    return `${y}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  /**
   * 头像。有图用图,没有就用首字母圆。
   * 这不是装饰:一整列长度相近的 @名字 是最难扫读的,左边有个能认人的色块
   * 就能靠位置快速定位。loading=lazy 免得一次拉两百张图。
   */
  function avatarHtml(r) {
    const ch = esc((r.sn || '?').slice(0, 1).toUpperCase());
    if (r.avatar) {
      // X 给的默认变体是 _normal(48px),在 34px 的圆里还行,但在高分屏上发虚。
      // 换成 _bigger 是**显示**的决定,所以放在这里,而不是去改存下来的数据。
      const url = String(r.avatar).replace(/_normal(\.\w+)$/, '_bigger$1');
      return `<img class="xf-av" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
    }
    return `<span class="xf-av xf-av-txt">${ch}</span>`;
  }

  // ── 数据 ────────────────────────────────────────────────────
  async function reload() {
    if (!alive()) return;
    state = await ns().loadState();
    if (!state) return;
    rows = ns().buildRows(state);
    // 上一次扫描的结果。**这一行必须读**:扫描是在页面跳转之后跑的,
    // 那时抽屉已经销毁、通知没人收 —— 少了它,用户就只看到"列表没变",
    // 完全不知道那一次到底跑了没有、抓到了几条。
    try {
      if (alive() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        lastAction = await new Promise((r) =>
          chrome.storage.local.get(['xf:lastAction'], (x) => r((x && x['xf:lastAction']) || null))
        );
      }
    } catch {
      lastAction = null;
    }

    try {
      if (alive() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        lastByList = await new Promise((r) =>
          chrome.storage.local.get(['xf:lastScanByList'], (x) => r((x && x['xf:lastScanByList']) || null))
        );
      }
    } catch {
      lastByList = null;
    }

    // 熔断状态不属于"关系数据",但它决定扫描条显示什么,所以顺手读一下
    try {
      const gate = ns().canScan ? await ns().canScan() : { ok: true };
      lockInfo = gate && gate.locked ? { reason: gate.reason, minutesLeft: gate.minutesLeft } : null;
    } catch {
      lockInfo = null;
    }
  }

  function tabRows(tab) {
    return ns().viewRows(rows, tab || activeTab);
  }

  function ignoredRows() {
    return ns().whitelisted(rows).filter((r) => r.id);
  }

  /**
   * 这一行需不需要额外说明。
   *
   * **只在"他说了跟别人不一样的话"时才显示。** 这是看了真机截图才发现的:
   * 「未回关」那一页每一行都在重复同一句"你关注了他 · 他没回关你" ——
   * 那句话对这页的**每个人**都成立, 等于六行噪音, 还把行高从 56 撑到 106,
   * 一屏只能看六个人。而列表才是用户来的目的。
   *
   * 所以: 默认情况**不显示**(交给 tab 上那句说明去讲), 只显示"这个人有什么不同",
   * 比如他什么时候取关的。「渣蓝」那一页则相反 —— 每行的取关时间都不同, 那是它的全部信息。
   */
  function relationText(r, tab) {
    if (tab === 'fans') return ''; // 这页每个人的情况都一样, 交给说明行
    if (!r.heStoppedAt) return ''; // 「我关注了他、他没回关我」是默认值, 不必每行重复
    const span = r.unfollowSpanDays == null ? '' : `关注 ${r.unfollowSpanDays} 天后取关`;
    const when = ago(r.heStoppedAt);
    return span ? `${span} · ${when}` : `${when}取关了你`;
  }

  /** 蓝V读不到的人不该被静默吞掉,数量要写在界面上 */
  function blueUnknownCount() {
    const pool = ns().fansNotFollowedBack(rows.filter((r) => !r.whitelisted));
    return ns().blueVUnknown(pool).length;
  }

  /**
   * 空态。**主句 + 说明**两层 —— 不再是一整段同色同重的灰字。
   * 也不在字符串里写字面 Markdown(以前 `**不成立**` 被转义之后会显示成星号)。
   */
  function emptyState(tab) {
    const list = LIST_LABEL[LIST_FOR_TAB[tab]];
    if (!rows.length) {
      return { title: `先扫描${list}`, desc: `读取本次最近 ${CAP} 位。扫描按钮在上方。` };
    }
    if (tab === 'fans') {
      const n = blueUnknownCount();
      return {
        title: '这次没有待回关的蓝V粉丝',
        desc: n ? `另有 ${n} 人的蓝V状态未读到,未计入。` : `已检查本轮最近 ${CAP} 位粉丝。`,
      };
    }
    if (tab === 'noback') return nobackEmptyText();
    return {
      title: '还没有取关变化记录',
      desc: '这一类靠前后两次粉丝名单的差异 —— 第一次扫描只建立记录,要把完整名单看全才推得出"他不在了"。',
    };
  }

  function scanSummary() {
    const parts = [];
    for (const t of ['following', 'followers']) {
      const r = lastByList && lastByList[t];
      if (!r) continue;
      parts.push(`${LIST_LABEL[t]} ${r.count} 条${r.flags ? '' : '·无关系标志'}`);
    }
    if (!parts.length) return `还没扫过 · 只扫最近 ${CAP} 个`;
    return `${ago(lastByList.following ? lastByList.following.ts : lastByList.followers.ts)}扫过:${parts.join(' · ')}`;
  }

  /**
   * 未回关为空时,**说清它为什么是空的**。
   *
   * 只写一句"没有没回关你的人"是没有信息量的 —— 用户看到 0 分不清是
   * "真的没有"还是"算不出来"。而这两种情况的修法完全不同。
   *
   * 所以这里把三个数摊开:我知道自己关注了多少人、其中多少人能确定回关状态、
   * 多少人读不到。如果读不到的数量很大,那句"0"就不成立,必须说出来。
   */
  function nobackEmptyText() {
    const pool = rows.filter((r) => !r.whitelisted);
    const scanned = pool.filter((r) => r.iFollow === true && r.followingFresh);
    const unknown = scanned.filter((r) => r.heFollows === null);

    if (!scanned.length) {
      return { title: '先扫描关注列表', desc: `读取本次最近 ${CAP} 位关注。` };
    }
    if (unknown.length) {
      return {
        title: '暂时无法判断谁没回关',
        // 不说"一个都没有"。这 0 不是因为没人不回关,是因为这一侧的关系事实读不到。
        desc: `本轮 ${scanned.length} 人中,${unknown.length} 人的关系状态未知。这不代表所有人都回关了你。`,
      };
    }
    return { title: '本轮没有发现未回关的人', desc: `已检查本轮 ${scanned.length} 位关注。` };
  }

  function counts() {
    const out = {};
    for (const t of TABS) out[t.key] = tabRows(t.key).length;
    return out;
  }

  function scanState() {
    const listType = LIST_FOR_TAB[activeTab];
    const buf = B.getBuffer(listType);
    const got = buf && buf.count ? buf.count : 0;
    const scanning = ns().isScanRunning ? ns().isScanRunning() : false;
    return { listType, got, scanning };
  }

  /** 一张列表最近一次扫到了什么,单独一行 —— 各带自己的时间,不合并成一句 */
  function listStatusLine(listType) {
    const r = lastByList && lastByList[listType];
    const label = LIST_LABEL[listType];
    if (!r) return { text: `${label} 还没扫过`, warn: false };
    return {
      text: `${label} ${r.count} · ${ago(r.ts)}${r.flags ? '' : ' · 无关系标志'}`,
      // 没有关系标志 = "他有没有回关我"算不出来,这一侧的结果不可用,必须显眼
      warn: !r.flags,
    };
  }

  function scanBarHtml() {
    const s = scanState();
    const label = LIST_LABEL[s.listType];
    const need = LIST_FOR_TAB[activeTab]; // 这一页依赖的那张列表
    const other = need === 'followers' ? 'following' : 'followers';
    const first = listStatusLine(need);
    const second = listStatusLine(other);

    const btn = s.scanning
      ? '<button class="xf-btn xf-btn-2" data-act="stop">停止</button>'
      : `<button class="xf-btn${rows.length ? ' xf-btn-2' : ''}" data-act="scan">扫描${label}</button>`;

    let head;
    let lines = [];
    if (s.scanning) {
      head = `<span class="xf-who">正在扫描${label}</span>`;
      lines = [busy && busy.message ? busy.message : `当前已捕获 ${s.got} 人`];
    } else if (lockInfo) {
      head = '<span class="xf-warnx">已暂停操作</span>';
      lines = [`${lockInfo.reason}${lockInfo.minutesLeft ? `,还需约 ${lockInfo.minutesLeft} 分钟` : ''}`];
    } else {
      head = '';
      lines = [scanError || first.text, second.text];
    }

    const right = lockInfo
      ? '<button class="xf-btn xf-btn-2" data-act="unlock">解除暂停</button>'
      : btn;

    return `<div class="xf-databar">
        ${head}
        <div class="xf-datalines">
          ${lines
            .filter(Boolean)
            .map((t) => `<span class="xf-dataline${scanError && t === scanError ? ' xf-dataline-bad' : ''}">${esc(t)}</span>`)
            .join('')}
          ${coverageText()}
        </div>
        ${right}
      </div>`;
  }

  /**
   * 角标覆盖率:**本页多少帖、标了几个**。
   *
   * 为什么要有这一行(两份外部方案都强调):角标是"只标有证据的人"的功能,
   * 覆盖率天然不满。没有这一行,用户会把"没角标"读成"已关注" —— 那是错误信息。
   * 只在页面上真有帖子时才显示,免得在名单页占地方。
   */
  function coverageText() {
    let all;
    try {
      all = document.querySelectorAll('article[data-testid="tweet"]');
    } catch {
      return '';
    }
    // **同一条口径**:都是"帖",而且都把嵌套的引用帖排除掉。
    // 原来分母数的是所有 article、分子却写"人",同一作者发三帖就报三人 ——
    // 用户会高估覆盖(外部审查 1.8)。
    const arts = Array.from(all).filter((a) => !(a.parentElement && a.parentElement.closest('article[data-testid="tweet"]')));
    if (!arts.length) return '';
    let marked = 0;
    for (const a of arts) {
      try {
        if (a.querySelector('.xf-uw')) marked += 1;
      } catch {
        /* ignore */
      }
    }
    // 顺便报一句"手里有多少作者的关系事实":没有它,"这页没人需要标"和
    // "数据通道死了"看起来一模一样(探针摘掉之后,这是唯一还留着的仪器)。
    let got = 0;
    try {
      const st = ns().badgeStats && ns().badgeStats();
      if (st && typeof st.facts === 'number') got = st.facts;
    } catch {
      /* ignore */
    }
    return (
      `<span class="xf-dataline">角标:本页 ${arts.length} 帖 · 标出 ${marked} 帖` +
      `(已读到 ${got} 位作者的关系;只标明确读到"未关注"的)</span>`
    );
  }

  function renderRow(r, tab) {
    const ign = r.whitelisted;
    const act = ACTION_OF_TAB[tab];
    const isIgnoredView = !!showIgnored;

    const doBtn =
      act && !ign && !isIgnoredView
        ? `<button class="xf-do${act.kind === 'unfollow' ? ' xf-do-undo' : ''}" data-row-act="do"
             data-id="${esc(r.id)}" data-sn="${esc(r.sn)}" data-kind="${act.kind}" data-verb="${esc(act.verb)}"
             title="在后台替你${esc(act.verb)} @${esc(r.sn)}"${jobBusy ? ' disabled' : ''}>${act.label}</button>`
        : '';

    const restBtn =
      ign || isIgnoredView
        ? `<button class="xf-ignore xf-restore" data-row-act="unignore" data-id="${esc(r.id)}" data-sn="${esc(r.sn)}">取消忽略</button>`
        : `<button class="xf-ignore" data-row-act="ignore" data-id="${esc(r.id)}" data-sn="${esc(r.sn)}">忽略</button>`;

    // 已忽略视图里**不套用某个名单的关系描述** —— 那个人可能是从另一张名单忽略的,
    // 沿用当前 tab 的说法就等于在编。
    const rel = isIgnoredView ? '已从名单中忽略' : relationText(r, tab);

    const name =
      `<a class="xf-name" href="https://x.com/${esc(r.sn)}" target="_blank" rel="noreferrer noopener"` +
      ` title="@${esc(r.sn)}">@${esc(r.sn)}</a>` +
      // 认证标记用一个**通用的"蓝圆 + 白勾"**,不是照抄 X 那个波浪边徽标 ——
      // 那是它的美术资产。16px 下两者看起来是同一个意思,但这不是它的图形。
      // 颜色走 currentColor,所以明暗主题自动跟着变。
      (r.blueV === true
        ? `<svg class="xf-blue" viewBox="0 0 24 24" width="15" height="15" role="img" aria-label="蓝V">` +
          '<circle cx="12" cy="12" r="11" fill="currentColor"/>' +
          '<path d="M6.6 12.5l3.3 3.3 7.6-7.7" fill="none" stroke="var(--xf-bg)" stroke-width="2.6" ' +
          'stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '');

    // **两个动作按钮永远钉在第一行(名字那一行)** —— 有说明文字时也在第一行。
    // 踩过两次:第一次没说明文字时按钮掉到第二行,"忽略"孤零零挂在取关下面;
    // 第二次修反了 —— 把动作组塞进第二行去陪伴说明文字,于是**有说明的行比没说明的行
    // 低一整行**(量过:名字 209 / 按钮 243),混合列表里一排"取关"高低不齐。
    // 只有第一行的高度是固定的(上内边距 10 + 首行 32),所以钉在第一行,
    // 行与行之间按钮才在同一条水平线上。它右侧的空档留给动作组,说明文字另起一行。
    // 动作组要**放进某一行里**,不能当行的兄弟 —— 主列是纵向 flex,
    // 放外面就会被堆到第二行,正是这里要修掉的那个问题。
    const acts = `<span class="xf-acts">${doBtn}${restBtn}</span>`;
    const line =
      `<span class="xf-l1">${name}${acts}</span>` +
      (rel ? `<span class="xf-l2"><span class="xf-rel" title="${esc(relFull(r, tab))}">${esc(rel)}</span></span>` : '');

    return `<li class="xf-row"${ign ? ' data-ign="1"' : ''}>
        <a class="xf-ava" href="https://x.com/${esc(r.sn)}" target="_blank" rel="noreferrer noopener"
           title="打开 @${esc(r.sn)} 的主页" aria-label="打开 @${esc(r.sn)} 的主页">${avatarHtml(r)}</a>
        <span class="xf-main">${line}</span>
      </li>`;
  }

  /** 关系描述上可能被截断,完整信息（含日期）放在 title 里 */
  function relFull(r, tab) {
    const rel = relationText(r, tab);
    if (!r.heStoppedAt) return rel;
    const d = new Date(r.heStoppedAt);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${rel}(取关于 ${ymd})`;
  }

  function listHtml() {
    const ignored = ignoredRows().length;

    if (showIgnored) {
      const list = ignoredRows();
      const head = `<div class="xf-viewhead"><span>已忽略 ${list.length} 人</span>
        <button class="xf-link" data-act="hide-ignored">回到名单</button></div>`;
      return (
        head +
        (list.length
          ? `<ul class="xf-list xf-list-ign">${list.map((r) => renderRow(r, activeTab)).join('')}</ul>`
          : `<div class="xf-empty"><p class="xf-empty-t">还没有忽略的账号</p></div>`)
      );
    }

    const list = tabRows();
    if (!list.length) {
      const e = emptyState(activeTab);
      return (
        `<div class="xf-empty"><p class="xf-empty-t">${esc(e.title)}</p>` +
        (e.desc ? `<p class="xf-empty-d">${esc(e.desc)}</p>` : '') +
        '</div>' +
        footHtml(ignored)
      );
    }
    return (
      `<ul class="xf-list">${list.map((r) => renderRow(r, activeTab)).join('')}</ul>` +
      // 到底的标线:列表短的时候下面是一大片空白,不写一句就像界面坏了
      `<div class="xf-end">到底了 · 共 ${list.length} 人</div>` +
      footHtml(ignored)
    );
  }
  function footHtml(ignored) {
    if (!ignored) return '';
    return `<div class="xf-foot"><button class="xf-link" data-act="show-ignored">已忽略 ${ignored} 人</button></div>`;
  }
  function render() {
    try {
      renderInner();
    } catch (e) {
      const body = $('.xf-body');
      if (body) {
        body.innerHTML = `<div class="xf-error">界面渲染出错:<br /><b>${esc(e && e.message)}</b><br />把这一行发出来。</div>`;
      }
      const t = $('.xf-handle-text');
      if (t) t.textContent = TITLE + ' · 出错';
    }
  }

  function renderInner() {
    if (!rootEl) return;
    const panel = $('.xf-panel');
    if (!panel) return;
    const c = counts();
    const cur = TABS.filter((t) => t.key === activeTab)[0] || TABS[0];

    // 计数**三个都要有,0 也显示**。原来只有非零才带数字,于是"回关检测"没有数字、
    // 另外两个有 —— 三个等分项的文字形状不一样,一栏看着就不齐。
    // 0 本身也是有用的信息("这一类现在是干净的"),不是噪声。
    const tabsHtml = TABS.map(
      (t) =>
        `<button class="xf-tab${t.key === activeTab ? ' on' : ''}" data-tab="${t.key}" title="${esc(t.hint)}">` +
        `${esc(t.label)}<i>${c[t.key] || 0}</i></button>`
    ).join('');

    panel.innerHTML =
      '<div class="xf-head">' +
      `<span class="xf-title">${TITLE}</span>` +
      '<button class="xf-icon" data-act="close" title="收起">✕</button>' +
      '</div>' +
      `<div class="xf-tabs">${tabsHtml}</div>` +
      `<div class="xf-hint">${esc(cur.hint)}</div>` +
      scanBarHtml() +
      (jobMsg ? `<div class="xf-job">${esc(jobMsg)}</div>` : '') +
      `<div class="xf-body">${listHtml()}</div>` +
      // 底部固定:使用反馈请关注作者。它是这个工具唯一的对外链接。
      `<div class="xf-author"><a href="${AUTHOR_URL}" target="_blank" rel="noreferrer noopener">` +
      '使用反馈请关注作者（百分百回关）</a></div>';

    // 收起时把手上的三个数。**带短标签** —— 原来只有三个红蓝黄数字,
    // 收起之后得记住颜色代表哪个名单。各名单可能重叠,所以不显示合计。
    const counts0 = $('.xf-hcounts');
    if (counts0) {
      // 顺序按用户说的:先「未」再「回」,渣蓝跟在后面(它没被要求去掉,
      // 而且是这个工具的名字,静默删掉反而不好)。
      const short = { noback: '未', fans: '回', sway: '渣' };
      const order = ['noback', 'fans', 'sway'];
      const full = TABS.map((t) => `${t.label} ${c[t.key]}`).join(' · ');
      const shown = order
        .map((k) => TABS.filter((t) => t.key === k)[0])
        .filter((t) => t && c[t.key])
        .map((t) => `<span class="xf-hg"><i>${short[t.key]}</i><b>${c[t.key] > 99 ? '99+' : c[t.key]}</b></span>`);
      counts0.innerHTML = shown.join('');
      const handle = $('.xf-handle');
      // 完整数字留在可访问文本里 —— 把手只缩写显示
      if (handle) handle.setAttribute('aria-label', `打开${TITLE}(${full})`);
    }
  }

  // ── 动作 ────────────────────────────────────────────────────
  async function doScan() {
    const listType = LIST_FOR_TAB[activeTab];
    busy = { message: `正在收集${LIST_LABEL[listType]}…` };
    scanError = null; // 新的一次开始,把上一次的失败清掉
    render();
    const r = await ns().requestScan(listType, { full: !!FULL_SCAN[activeTab] });
    busy = null;
    if (r && r.ok === false && r.reason) {
      scanError = r.reason;
      await reload(); // 可能正是熔断 —— 让扫描条切成「解除暂停」
      render();
      return;
    }
    // 扫描可能把页面导航走了,新页面上会继续推进度
    window.setTimeout(() => {
      reload().then(render).catch(() => {});
    }, 600);
  }

  async function setIgnore(id, sn, on) {
    if (!alive()) return;
    const fn = on ? ns().whitelistAdd : ns().whitelistRemove;
    await fn(id, sn);
    await reload();
    render();
  }

  /**
   * 让后台标签页替你点 X 自己的按钮(关注或取关)。
   *
   * 这里只做三件事:写一条任务、请后台派车、把结果说出来。
   * 真正的点击在 worker.js 里,发生在**后台标签页**上 —— 你的这一页不受影响。
   */
  async function doAction(r, kind) {
    if (jobBusy) return;
    if (!alive() || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      jobMsg = '扩展上下文已失效 —— 刷新一下 x.com。';
      render();
      return;
    }
    const verb = (ACTION_OF_TAB[activeTab] && ACTION_OF_TAB[activeTab].verb) || (kind === 'unfollow' ? '取关' : '关注');
    jobBusy = true;
    jobMsg = `正在后台打开 @${r.sn} 的主页,准备替你${verb}…`;
    render();

    // 一次性身份。任务状态是**所有上下文共享的一个键**,没有身份就无法判断
    // "现在存储里这条还是不是我在做的那条" —— 审查就是靠这一点复现出
    // "旧快照把已失败的任务改回成功"和"跨标签页误杀正在跑的任务"的。
    const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      jobId,
      kind: kind === 'unfollow' ? 'unfollow' : 'follow',
      verb, // 用户看到的动词 —— worker 回话时原样用,免得两边措辞不一致
      id: String(r.id),
      sn: r.sn,
      status: 'pending',
      at: Date.now(),
    };
    await new Promise((resolve) => chrome.storage.local.set({ 'xf:job': job }, resolve));

    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'xf:run-job' }, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch {
        resolve(null);
      }
    });

    if (!res || !res.ok) {
      jobBusy = false;
      jobMsg = '没能开始:' + ((res && res.reason) || '后台没有回应');
      // 任务写进去了但没派上车,清掉,免得下次被当成"上一个还没做完"。
      // **但只在它还是我那条的时候清** —— 无条件清会把别的标签页正在跑的任务杀掉
      // (审查复现过:后续状态并进空记录,界面显示 @undefined)。
      await new Promise((resolve) => {
        chrome.storage.local.get(['xf:job'], (x) => {
          const cur = (x && x['xf:job']) || null;
          if (cur && cur.jobId && cur.jobId !== jobId) return resolve();
          chrome.storage.local.set({ 'xf:job': null }, resolve);
        });
      });
      render();
      return;
    }
    // 剩下的交给 storage 变更通知 —— 后台执行完会更新任务状态
  }

  /** 任务状态变了就刷新界面:你可能已经切走了,回来要能看到结果 */
  function watchJob() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['xf:job']) return;
      const job = changes['xf:job'].newValue;
      if (!job) return;
      const verb = job.verb || (job.kind === 'unfollow' ? '取关' : '关注');
      if (job.status === 'dispatched' || job.status === 'booting') {
        jobBusy = true;
        jobMsg = `正在后台打开 @${job.sn} 的主页,准备替你${verb}…`;
        render();
        return;
      }
      if (job.status === 'running') {
        jobBusy = true;
        jobMsg = `正在后台替你${verb} @${job.sn}…`;
        render();
        return;
      }
      if (job.status === 'clicked') {
        // 点完了但拿不准 —— 后台会重新加载他的主页去查一次真实状态。
        // 这一步必须说出来,否则用户看到的就是"停住了"。
        jobBusy = true;
        jobMsg = `已经点过了,正在重新加载 @${job.sn} 的主页确认结果…`;
        render();
        return;
      }
      if (job.status === 'done') {
        jobBusy = false;
        // 把"走的哪条路、写的哪个端点、花了多久"一起显示出来。
        // **不显示就等于没记** —— 前面几轮优化全靠猜,就是因为这些数字躺着没人看。
        const nav = job.viaNav === 'spa' ? ' · 快路' : '';
        const ep = job.endpoint ? ` · 端点 ${job.endpoint}` : '';
        const t = fmtTimings(job.timings);
        jobMsg = `✓ 已${verb} @${job.sn}(${job.via || ''}${nav}${ep}${t})`;
        reload().then(render).catch(() => render());
        return;
      }
      if (job.status === 'failed') {
        jobBusy = false;
        jobMsg = `✗ @${job.sn} 没有${verb}:${job.reason || '原因不明'}`;
        reload().then(render).catch(() => render());
      }
    });
  }

  /**
   * 看门狗:任务派出去很久还没进入"正在做",说明后台标签页那边没起来。
   *
   * 没有它的时候,这种情况在界面上就是"永远停在一句话上不动" ——
   * 用户既不知道该等还是该重试,我也拿不到任何信息。现在它会自己说出来。
   */
  // 一个任务最多活多久。超过就由界面来收尾 —— 因为**只有界面一定活着**:
  //   · worker 在后台标签页里,那个标签页可能被冻结或关掉,它就没了
  //   · 后台的定时兜底只在 service worker 活着时跑,而 MV3 的 SW 空闲就被回收
  // 原来这个看门狗**跳过了 running**,理由是"它总会自己出结论" —— 而它不会。
  // 结果就是界面永远停在"正在后台替你关注…"上,既没有结论也没有出路。
  const JOB_DEAD_MS = 40000;

  async function checkStuckJob() {
    if (!jobBusy || !alive() || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    const read = () =>
      new Promise((r) => chrome.storage.local.get(['xf:job'], (x) => r((x && x['xf:job']) || null)));

    const job = await read();
    if (!job) {
      jobBusy = false;
      jobMsg = '任务不见了 —— 再点一次试试。';
      render();
      return;
    }
    // 已经有结论(或正在被复查接手)的,不归这里管
    if (job.status === 'done' || job.status === 'failed' || job.status === 'clicked') return;

    const since = job.startedAt || job.dispatchedAt || job.at || 0;
    if (!since || Date.now() - since < JOB_DEAD_MS) return;

    // 写结论之前再确认一次 —— 免得把刚刚落地的真实结果覆盖掉,
    // 也免得把**用户之后又点的那一条**新任务判死。
    const fresh = await read();
    if (!fresh || fresh.status === 'done' || fresh.status === 'failed' || fresh.status === 'clicked') return;
    if (fresh.jobId && job.jobId && fresh.jobId !== job.jobId) return;

    jobBusy = false;
    const secs = Math.round(JOB_DEAD_MS / 1000);
    jobMsg =
      `@${job.sn} 这次没有回音(等了 ${secs} 秒,状态停在「${job.status}」)。` +
      '大概率是那个后台标签页被冻结或已关闭 —— 再点一次试试。';
    // 把结论写下去:这样下一次点击不会被"上一个还没做完"挡住
    await new Promise((r) =>
      chrome.storage.local.set(
        { 'xf:job': Object.assign({}, fresh, { status: 'failed', reason: jobMsg, finishedAt: Date.now() }) },
        r
      )
    );
    render();
  }

  /**
   * 收到一条扫描通知,该做什么。
   *
   * 抽成纯函数是为了能直接测 —— 这条判断错了的表现是"扫完了名单没变",
   * 而那种错在手动点一遍的时候很容易被当成"还没扫完"。
   *
   * @returns 'ignore' | 'clear' | 'refresh' | 'busy'
   */
  function scanNoticeAction(p) {
    if (!p) return 'ignore';
    if (p.kind === 'idle') return 'clear';
    // 有布尔结论 = 这一轮扫描结束了(成功或失败),账本已经改过 → 重读
    if (p.kind === 'scan' && typeof p.ok === 'boolean') return 'refresh';
    return 'busy';
  }

  /** 提示写在状态行里 —— 不要用 alert,那会把页面卡住 */
  function setStatus(msg) {
    scanError = msg;
    const el = $('.xf-status');
    if (el) el.textContent = msg;
  }

  function openProfile(sn) {
    if (!sn) return;
    // 新标签页打开:原列表留着,处理完切回来接着看下一个。
    // 不用 location.href —— 那会把这个列表连同刚扫出来的数据一起丢掉。
    window.open('https://x.com/' + sn, '_blank', 'noopener,noreferrer');
  }

  // ── 事件:全部委托在根节点上,只绑一次 ────────────────────────
  // 上一版每次重绘都绑一遍,于是监听器越积越多、按钮"越点越多次"。
  function bind() {
    rootEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;

      const rowBtn = t.closest('[data-row-act]');
      if (rowBtn) {
        ev.stopPropagation(); // 别让"忽略"顺手把主页也打开了
        const act = rowBtn.dataset.rowAct;
        if (act === 'open') openProfile(rowBtn.dataset.sn);
        else if (act === 'do') {
          const row = (rows || []).filter((x) => x.id === rowBtn.dataset.id)[0];
          doAction(row || { id: rowBtn.dataset.id, sn: rowBtn.dataset.sn }, rowBtn.dataset.kind).catch(() => {});
        } else if (act === 'ignore') setIgnore(rowBtn.dataset.id, rowBtn.dataset.sn, true).catch(() => {});
        else if (act === 'unignore') setIgnore(rowBtn.dataset.id, rowBtn.dataset.sn, false).catch(() => {});
        return;
      }

      const row = t.closest('.xf-row');
      if (row && row.dataset.open) {
        openProfile(row.dataset.open);
        return;
      }

      const tabBtn = t.closest('.xf-tab');
      if (tabBtn) {
        activeTab = tabBtn.dataset.tab;
        showIgnored = false;
        if (alive() && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [TAB_KEY]: activeTab });
        }
        render();
        return;
      }

      const btn = t.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') setOpen(false);
      else if (act === 'open-panel') setOpen(true);
      else if (act === 'scan') doScan().catch((e) => setStatus('扫描出错:' + (e && e.message)));
      else if (act === 'stop') {
        ns().stopScan();
        render();
      } else if (act === 'unlock') {
        ns()
          .manualUnlock()
          .then(() => reload())
          .then(render)
          .catch(() => {});
      } else if (act === 'show-ignored') {
        showIgnored = true;
        render();
      } else if (act === 'hide-ignored') {
        showIgnored = false;
        render();
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && open) setOpen(false);
    });
  }

  // ── 样式 ────────────────────────────────────────────────────
  // 配色沿用 X 自己那套深色(#15202b 底 / #1d9bf0 主色 / #8b98a5 次要文字),
  // 这样抽屉贴在页面上不像一块外来的东西。规则一行一条,不再挤成单行。
  // ── 样式 ────────────────────────────────────────────────────
  // 规格来自外部评审:4 级字号、4px 间距刻度、88px 行高、两行版式、
  // 两套变量兼容明暗。**所有值都走变量** —— 换主题不需要改任何结构。
  const CSS = [
    '#xf-sidebar{',
    '  --xf-bg:#15202b; --xf-surface:#1c2733; --xf-hover:#22303c;',
    '  --xf-text:#e7e9ea; --xf-secondary:#b4bec8; --xf-muted:#8b98a5;',
    '  --xf-divider:#2b3947; --xf-control-border:#657786;',
    '  --xf-accent:#1d9bf0;',
    // X 的主按钮是**黑白**的:浅色黑底白字,深色白底黑字。蓝色在 X 里是链接和徽标的颜色,
    // 不是按钮的 —— 照这个分工,按钮的"可点"感来自**最高对比**,不来自品牌色。
    '  --xf-btn-bg:#eff3f4; --xf-btn-text:#0f1419;',
    '  --xf-danger:#ff7a85; --xf-danger-bg:rgba(244,33,46,.12);',
    '  --xf-warning:#ffcc66; --xf-success:#6edbb0;',
    '  --xf-shadow:-8px 0 24px rgba(0,0,0,.24);',
    '  position:fixed;inset:0 0 0 auto;width:0;z-index:2147483646;pointer-events:none;',
    '  font:13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;',
    '  color:var(--xf-text)}',
    // 浅色:跟随系统偏好。**它不等于用户在 X 里选的主题** —— 那由下面的
    // [data-xf-theme] 覆盖(我们只读页面实际背景的亮度,不假定 X 有什么属性)。
    '@media (prefers-color-scheme:light){#xf-sidebar{',
    '  --xf-bg:#ffffff; --xf-surface:#f7f9f9; --xf-hover:#eef3f6;',
    '  --xf-text:#0f1419; --xf-secondary:#536471; --xf-muted:#536471;',
    '  --xf-divider:#e5e9ed; --xf-control-border:#6b7c8c;',
    '  --xf-accent:#0b69b7;',
    '  --xf-btn-bg:#0f1419; --xf-btn-text:#ffffff;',
    '  --xf-danger:#b42332; --xf-danger-bg:rgba(244,33,46,.09);',
    '  --xf-warning:#8a5700; --xf-success:#0b7a53;',
    '  --xf-shadow:-8px 0 24px rgba(0,0,0,.10)}}',
    // 页面实际外观的覆盖(读页面背景亮度得到),放在媒体查询之后才能盖住它
    '#xf-sidebar[data-xf-theme="dark"]{',
    '  --xf-bg:#15202b; --xf-surface:#1c2733; --xf-hover:#22303c;',
    '  --xf-text:#e7e9ea; --xf-secondary:#b4bec8; --xf-muted:#8b98a5;',
    '  --xf-divider:#2b3947; --xf-control-border:#657786;',
    '  --xf-accent:#1d9bf0;',
    '  --xf-btn-bg:#eff3f4; --xf-btn-text:#0f1419;',
    '  --xf-danger:#ff7a85; --xf-danger-bg:rgba(244,33,46,.18);',
    '  --xf-warning:#ffcc66; --xf-success:#6edbb0;',
    '  --xf-shadow:-8px 0 24px rgba(0,0,0,.24)}',
    '#xf-sidebar[data-xf-theme="light"]{',
    '  --xf-bg:#ffffff; --xf-surface:#f7f9f9; --xf-hover:#eef3f6;',
    '  --xf-text:#0f1419; --xf-secondary:#536471; --xf-muted:#536471;',
    '  --xf-divider:#e5e9ed; --xf-control-border:#6b7c8c;',
    '  --xf-accent:#0b69b7;',
    '  --xf-btn-bg:#0f1419; --xf-btn-text:#ffffff;',
    '  --xf-danger:#b42332; --xf-danger-bg:rgba(244,33,46,.09);',
    '  --xf-warning:#8a5700; --xf-success:#0b7a53;',
    '  --xf-shadow:-8px 0 24px rgba(0,0,0,.10)}',
    '#xf-sidebar *,#xf-sidebar *::before,#xf-sidebar *::after{box-sizing:border-box}',
    '#xf-sidebar[data-open="1"]{width:min(380px,100vw)}',
    '#xf-sidebar a{color:inherit;text-decoration:none}',
    '#xf-sidebar :focus-visible{outline:2px solid var(--xf-accent);outline-offset:2px}',

    // 收起时的把手:36px 中性条,数字带短标签,不再靠红蓝黄表示是哪个名单
    '#xf-sidebar .xf-handle{pointer-events:auto;position:absolute;top:120px;right:0;width:36px;',
    '  display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0;cursor:pointer;',
    '  background:var(--xf-bg);border:1px solid var(--xf-control-border);border-right:0;',
    '  border-radius:8px 0 0 8px;color:var(--xf-text)}',
    '#xf-sidebar .xf-handle:hover{background:var(--xf-hover)}',
    // 竖着一个字母一行:text-orientation:upright 让拉丁字母保持正着排,不旋转
    '#xf-sidebar .xf-htitle{writing-mode:vertical-rl;text-orientation:upright;font-weight:700;',
    '  font-size:12px;letter-spacing:1px}',
    '#xf-sidebar .xf-author{flex:none;padding:10px 16px;border-top:1px solid var(--xf-divider);',
    '  font-size:12px;line-height:18px;text-align:center}',
    '#xf-sidebar .xf-author a{color:var(--xf-accent)}',
    '#xf-sidebar .xf-author a:hover{text-decoration:underline}',
    '#xf-sidebar .xf-hcounts{display:flex;flex-direction:column;gap:8px;align-items:center}',
    '#xf-sidebar .xf-hg{display:flex;flex-direction:column;align-items:center;line-height:1.25}',
    '#xf-sidebar .xf-hg i{font-style:normal;font-size:11px;color:var(--xf-muted)}',
    '#xf-sidebar .xf-hg b{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
    '#xf-sidebar[data-open="1"] .xf-handle{display:none}',

    '#xf-sidebar .xf-panel{pointer-events:auto;position:absolute;top:0;right:0;height:100vh;width:100%;',
    '  display:none;flex-direction:column;background:var(--xf-bg);border-left:1px solid var(--xf-divider);',
    '  box-shadow:var(--xf-shadow)}',
    '#xf-sidebar[data-open="1"] .xf-panel{display:flex}',

    '#xf-sidebar .xf-head{display:flex;align-items:center;gap:8px;height:56px;padding:0 16px;flex:none}',
    '#xf-sidebar .xf-title{flex:1;font-size:16px;line-height:24px;font-weight:700}',
    '#xf-sidebar .xf-icon{width:32px;height:32px;display:flex;align-items:center;justify-content:center;',
    '  background:none;border:0;color:var(--xf-muted);font-size:16px;cursor:pointer;border-radius:8px}',
    '#xf-sidebar .xf-icon:hover{background:var(--xf-hover);color:var(--xf-text)}',

    // tabs:透明三等分导航 + 2px 选中线,不再是一排胶囊
    '#xf-sidebar .xf-tabs{display:flex;height:40px;padding:0 16px;flex:none}',
    '#xf-sidebar .xf-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;',
    '  border:0;background:none;color:var(--xf-secondary);font:600 13px/20px inherit;',
    '  padding:0 4px;cursor:pointer;box-shadow:inset 0 -2px 0 transparent;white-space:nowrap}',
    '#xf-sidebar .xf-tab:hover{color:var(--xf-text)}',
    '#xf-sidebar .xf-tab.on{color:var(--xf-text);box-shadow:inset 0 -2px 0 var(--xf-accent)}',
    '#xf-sidebar .xf-tab i{font-style:normal;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',

    // 说明文字**居中**。它是选中的那一页的说明,跟上面居中的标签是一组;
    // 靠左贴着的话,和下面同样靠左的数据行连成三行一样的灰字,读起来像一段话,
    // 分不清哪句说的是"这一页"、哪句说的是"数据到哪了"。
    '#xf-sidebar .xf-hint{padding:12px 16px 0;color:var(--xf-secondary);font-size:12px;line-height:18px;',
    '  flex:none;text-align:center}',

    // 数据条:两条各自带时间的状态行 + 右侧固定按钮
    '#xf-sidebar .xf-databar{display:flex;align-items:flex-start;gap:12px;padding:8px 16px 12px;flex:none}',
    '#xf-sidebar .xf-datalines{flex:1;min-width:0;display:flex;flex-direction:column;gap:0}',
    '#xf-sidebar .xf-dataline{display:block;font-size:12px;line-height:18px;color:var(--xf-muted);',
    '  overflow-wrap:anywhere}',
    '#xf-sidebar .xf-dataline-bad{color:var(--xf-danger)}',
    '#xf-sidebar .xf-who{font-size:13px;line-height:20px;color:var(--xf-text);font-weight:600}',
    '#xf-sidebar .xf-warnx{font-size:13px;line-height:20px;color:var(--xf-warning);font-weight:600}',

    // 所有按钮共用一套"手感":等高、居中的字、有过渡。
    // **描边是"线框感"的来源** —— 所以默认不用描边,靠底色的深浅分主次。
    // 按钮的手感**照 X 自己的来**:完全圆角的胶囊、700 字重、宽松内边距。
    // 之前是 radius 8 + 600 字重 + 10px 内边距 —— 那个组合看起来像表单控件,
    // 不像按钮,这就是"简陋"的来源。工具活在 X 里,就该说它那套语言。
    // (面板里的 tabs / 分段控件仍然不是胶囊,免得整页变成一排胶囊。)
    '#xf-sidebar .xf-btn,#xf-sidebar .xf-do,#xf-sidebar .xf-ignore{',
    '  display:inline-flex;align-items:center;justify-content:center;',
    '  border:1px solid transparent;border-radius:999px;font:700 13px/1 inherit;',
    '  cursor:pointer;white-space:nowrap;letter-spacing:.2px;',
    '  transition:background-color .15s,color .15s,border-color .15s;}',
    '#xf-sidebar .xf-btn{flex:none;min-width:112px;height:34px;padding:0 18px;',
    '  background:var(--xf-btn-bg);color:var(--xf-btn-text)}',
    // 扫描按钮**一直**是主按钮的样子:它本来就是这一页的主操作。
    // (以前"已有数据时退成次级"是为了不跟行内按钮抢注意力 —— 现在行内也是同一套黑白,
    //  不存在抢的问题,统一反而更像一个产品)
    '#xf-sidebar .xf-btn-2{background:var(--xf-btn-bg);color:var(--xf-btn-text)}',
    '#xf-sidebar .xf-btn:hover{opacity:.88}',
    '#xf-sidebar .xf-btn[disabled]{opacity:.5;cursor:default;filter:none;box-shadow:none}',

    '#xf-sidebar .xf-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;',
    '  border-top:1px solid var(--xf-divider)}',
    '#xf-sidebar .xf-list{list-style:none;margin:0;padding:0}',

    // 行:固定两行。分割线从内容区左侧(x64)开始,不再一行一个卡片
    // 行内**顶端对齐**,不是整行居中 —— 头像要对齐的是"名字那一行"。
    // 量过:整行居中时头像中心在 227、名字中心在 209,差 18px,
    // 看起来就是头像浮在中间、跟名字脱开了。
    '#xf-sidebar .xf-row{display:flex;gap:12px;padding:0 16px;align-items:flex-start}',
    // 10px = 主列的上内边距,所以头像正好盖住"名字那一行"(32px)
    // 底色只放**外层圆**这一处。图自己不铺底色 —— 它铺的话会把外层的灰盖掉,
    // 于是"有头像的人"和"只有首字母的人"看起来还是两种东西(预览里就是
    // 一个黑色小人 vs 一个灰圆 S)。图没加载出来时,露出的就是同一个灰圆。
    '#xf-sidebar .xf-ava{flex:none;width:32px;height:32px;margin-top:10px;border-radius:50%;',
    '  display:block;overflow:hidden;background:var(--xf-hover)}',
    '#xf-sidebar .xf-av{width:32px;height:32px;border-radius:50%;object-fit:cover;',
    '  background:transparent;display:block}',
    // 首字母圆要**看得清**:原来用最浅的那个灰,在深色底上像禁用状态
    '#xf-sidebar .xf-av-txt{display:flex;align-items:center;justify-content:center;',
    '  color:var(--xf-text);background:var(--xf-hover);font-weight:600;font-size:13px}',
    // 行高构成:12(上) + 32(首行) + 4(间隙) + 28(次行) + 12(下) = 88
    // 行高由内容决定:只有一行时 56px,有"不一样的话"时才长到 84px。
    // (原来是写死 88 —— 于是六行就占满一屏)
    // 行高由内容决定:单行 ~52px,只有"要说不一样的话"时才多一行
    '#xf-sidebar .xf-main{flex:1;min-width:0;display:flex;flex-direction:column;',
    '  justify-content:center;padding:10px 0;border-bottom:1px solid var(--xf-divider)}',
    '#xf-sidebar .xf-l1{display:flex;align-items:center;gap:8px;min-height:32px;min-width:0}',
    '#xf-sidebar .xf-l2{display:flex;align-items:center;gap:8px;margin-top:2px;min-height:24px}',
    // 动作组:永远贴右,绝不换行
    '#xf-sidebar .xf-acts{flex:none;display:flex;align-items:center;gap:10px;margin-left:auto}',
    // 只有按钮、没有说明文字时,让按钮那行靠右且不占高度
    // **不能让名字撑满**:撑满会把蓝V推到最右边,看起来跟这个人没关系了。
    // 名字吃自己的内容宽度(长了才省略),动作组靠 margin-left:auto 顶到右边。
    '#xf-sidebar .xf-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
    '  white-space:nowrap;font-size:14px;line-height:20px;font-weight:600}',
    '#xf-sidebar .xf-name:hover{text-decoration:underline}',
    '#xf-sidebar .xf-blue{flex:none;display:block;color:var(--xf-accent)}',
    '#xf-sidebar .xf-rel{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;color:var(--xf-secondary);',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

    '#xf-sidebar .xf-do{flex:none;min-width:68px;height:32px;padding:0 16px;',
    '  background:var(--xf-btn-bg);color:var(--xf-btn-text)}',
    // 取关也是实心 —— 它就是这一行要做的动作,可点性要一样明显。
    // hover 转红提示它是破坏性动作(X 的「正在关注」也是 hover 才变红)。
    '#xf-sidebar .xf-do-undo{background:var(--xf-btn-bg);color:var(--xf-btn-text)}',
    '#xf-sidebar .xf-do-undo:hover{background:var(--xf-danger-bg);color:var(--xf-danger);',
    '  border-color:var(--xf-danger);opacity:1}',
    '#xf-sidebar .xf-do[disabled]{opacity:.5;cursor:default;box-shadow:none}',

    // 忽略:平时是文字,hover 才浮出一层底 —— 它是次要动作,不该常驻一个按钮的样子
    // 忽略:纯文字,只有字色变 —— X 的次要文字动作就是这样,不给它加底
    '#xf-sidebar .xf-ignore{flex:none;min-width:32px;height:32px;padding:0 8px;',
    '  background:transparent;color:var(--xf-muted);font-weight:600;border-color:transparent}',
    '#xf-sidebar .xf-ignore:hover{color:var(--xf-text)}',
    '#xf-sidebar .xf-restore{min-width:88px;height:32px;background:var(--xf-btn-bg);',
    '  color:var(--xf-btn-text)}',
    '#xf-sidebar .xf-restore:hover{background:var(--xf-danger-bg);color:var(--xf-danger);',
    '  border-color:var(--xf-danger)}',

    // 已忽略行:**不整行降透明度** —— 那会把可点的"取消忽略"也弄得像禁用。
    // 只让头像降饱和,文字保持对比度,并且明写一句"已从名单中忽略"。
    '#xf-sidebar .xf-row[data-ign="1"] .xf-av{filter:saturate(.25)}',
    '#xf-sidebar .xf-list-ign .xf-main{border-bottom-color:var(--xf-divider)}',

    '#xf-sidebar .xf-end{padding:14px 16px 4px;text-align:center;font-size:12px;',
    '  line-height:18px;color:var(--xf-muted)}',
    '#xf-sidebar .xf-viewhead,#xf-sidebar .xf-foot{display:flex;align-items:center;',
    '  min-height:44px;padding:0 16px;color:var(--xf-muted);font-size:12px;line-height:18px}',
    // 视图头是"左标题 + 右出口"一行,footer 只有一个链接。
    // **两者不能共用 space-between**:单个子元素会被推到最左,于是
    // footer 那行靠左、紧挨着的"到底了"那行居中,两行对齐方式不一样。
    '#xf-sidebar .xf-viewhead{justify-content:space-between}',
    '#xf-sidebar .xf-foot{justify-content:center}',
    '#xf-sidebar .xf-link{background:none;border:0;color:var(--xf-accent);font:inherit;cursor:pointer;padding:0}',
    '#xf-sidebar .xf-link:hover{text-decoration:underline}',

    // 空态**在列表区里居中** —— 原来贴着顶,下面是几百像素的空白,看起来像加载失败
    '#xf-sidebar .xf-empty{display:flex;flex-direction:column;justify-content:center;',
    '  min-height:52vh;padding:24px;text-align:center}',
    '#xf-sidebar .xf-empty-t{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--xf-text)}',
    '#xf-sidebar .xf-empty-d{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--xf-secondary);',
    '  overflow-wrap:anywhere}',
    '#xf-sidebar .xf-job{padding:8px 16px;font-size:13px;line-height:20px;color:var(--xf-secondary);',
    '  background:var(--xf-surface);border-top:1px solid var(--xf-divider);',
    '  border-bottom:1px solid var(--xf-divider);overflow-wrap:anywhere}',
    '#xf-sidebar .xf-error{padding:16px;font-size:13px;line-height:20px;color:var(--xf-danger);',
    '  overflow-wrap:anywhere}',
    '#xf-sidebar .xf-fatal{position:fixed;top:0;right:0;z-index:2147483647;max-width:380px;',
    '  padding:8px 12px;background:var(--xf-danger);color:var(--xf-bg);font:12px/18px sans-serif}',
    '@media (prefers-reduced-motion:reduce){#xf-sidebar *{transition:none!important;animation:none!important}}',
  ].join('\n');

  // ── 主题:只读地跟随页面实际外观 ─────────────────────────────
  //
  // 用户在 X 上开浅色、抽屉却是深色,会很割裂。所以读**页面实际的背景亮度**
  // 来决定我们自己的明暗,而不是假定 X 有什么 data-theme 属性(那不一定存在)。
  //
  // 只做三件事:读一个颜色、在**我们自己的** root 上设 data-xf-theme、监听那个节点
  // 的属性变化。不写 X 的节点、不改它一个字节。
  function parseRgb(str) {
    const m = String(str || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(',').map((x) => parseFloat(x));
    const [r, g, b] = parts;
    if ([r, g, b].some((v) => !isFinite(v))) return null;
    const a = parts.length > 3 ? parts[3] : 1;
    return { r, g, b, a: isFinite(a) ? a : 1 };
  }

  function detectTheme() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      let bg = '';
      try {
        bg = getComputedStyle(el).backgroundColor || '';
      } catch {
        bg = '';
      }
      const c = parseRgb(bg);
      // 透明不算数 —— 从一个透明 body 推"深色"是瞎猜,交给 prefers-color-scheme 兜底
      if (!c || c.a === 0) continue;
      const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      return lum > 0.5 ? 'light' : 'dark';
    }
    return null;
  }

  let themeObserver = null;
  function applyTheme() {
    if (!rootEl) return;
    const t = detectTheme();
    if (t) rootEl.dataset.xfTheme = t;
    else delete rootEl.dataset.xfTheme; // 读不到 → 让媒体查询兜底
  }

  function watchTheme() {
    applyTheme();
    if (themeObserver) return;
    const targets = [document.body, document.documentElement].filter(Boolean);
    if (!targets.length) return;
    themeObserver = new MutationObserver(() => applyTheme());
    // **只监听这两个节点自己的属性**,不监听整棵子树 ——
    // 否则我们给自己设 data-xf-theme 也会把观察器叫醒,来回触发。
    for (const t of targets) {
      themeObserver.observe(t, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'] });
    }
  }

  // ── 挂载 ────────────────────────────────────────────────────
  function ensureDrawer() {
    const existing = document.getElementById('xf-sidebar');
    if (existing) existing.remove();

    rootEl = document.createElement('div');
    rootEl.id = 'xf-sidebar';
    rootEl.dataset.open = '0';
    rootEl.innerHTML =
      `<div class="xf-handle" data-act="open-panel" role="button" tabindex="0" title="打开${TITLE}">` +
      `<span class="xf-htitle">${HANDLE_TEXT}</span><span class="xf-hcounts"></span></div>` +
      '<div class="xf-panel"></div>';

    const style = document.createElement('style');
    style.textContent = CSS;
    // 挂到 head 上,并且用 CSSOM 的 textContent 赋值 —— 不用内联 style 属性,
    // 那种写法会被一部分站点的 CSP 直接拦掉,表现就是"抽屉打开了但没有样式"。
    (document.head || document.documentElement).appendChild(style);

    document.documentElement.appendChild(rootEl);
    bind();
  }

  function setOpen(v) {
    open = !!v;
    if (!rootEl) return;
    rootEl.dataset.open = open ? '1' : '0';
    if (open) {
      applyTheme();
      render(); // 先用手上的数据画一版,别让用户看到空白
      reload()
        .then(render)
        .catch(() => render());
    }
  }

  function toggle() {
    setOpen(!open);
  }

  function readSavedTab() {
    return new Promise((resolve) => {
      if (!alive() || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return resolve();
      }
      chrome.storage.local.get([TAB_KEY], (r) => {
        const t = r && r[TAB_KEY];
        if (t && TABS.some((x) => x.key === t)) activeTab = t;
        resolve();
      });
    });
  }

  function mount() {
    if (rootEl) return;
    try {
      // 后台执行器那个标签页不装界面 —— 它只是去点一下,不需要给人看
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: 'xf:whoami' }, (resp) => {
            void chrome.runtime.lastError;
            if (!resp || !resp.isWorker) mountUi();
          });
          return;
        } catch {
          /* 取不到就按普通页面处理 */
        }
      }
      mountUi();
    } catch (e) {
      showFatal(e);
    }
  }

  /** 兜底提示也要走作用域类 —— 不用内联 style,那在某些站点的 CSP 下会被拦掉 */
  function showFatal(e) {
    const div = document.createElement('div');
    div.className = 'xf-fatal';
    div.setAttribute('data-xf-inline-of', 'sidebar');
    // 这一类是"连样式表都没上去"时的兜底,所以它必须自带最小内联样式 ——
    // 但它只出现在真正的致命错误上,正常路径一个内联 style 都没有。
    div.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;padding:8px 12px';
    div.textContent = TITLE + ' 加载出错:' + (e && e.message);
    document.documentElement.appendChild(div);
  }

  function mountUi() {
    try {
      ensureDrawer();
      watchTheme();
      watchJob();
      readSavedTab().then(() => {
        reload()
          .then(render)
          .catch(() => render());
      });

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
          if (msg && msg.type === 'xf:toggle-sidebar') {
            toggle();
            reply({ ok: true });
            return true;
          }
          return undefined;
        });
      }

      const onChange = () => {
        if (!open || showIgnored) return;
        reload()
          .then(render)
          .catch(() => {});
      };
      if (B && B.onUpdate) B.onUpdate(onChange);
      if (B && B.onNavigate) {
        B.onNavigate(() => {
          if (!open) return;
          window.setTimeout(onChange, 800);
        });
      }
      if (B && B.onLimit) {
        B.onLimit((info) => setStatus('被 X 限流了,已经停下来:' + ((info && info.reason) || '先别扫')));
      }
      if (ns().onProgress) {
        ns().onProgress((p) => {
          const act = scanNoticeAction(p);
          if (act === 'clear') {
            busy = null;
            if (open && !showIgnored) render();
            return;
          }
          if (act === 'refresh') {
            // 扫描有结论了 —— 账本刚被改写,**必须重读**,不能只重绘。
            // 只重绘的话画面用的是扫描前的 rows,看起来就是"扫完了名单没变",
            // 要等 5 秒兜底轮询才更新。这就是用户报的那个 bug。
            busy = null;
            reload()
              .then(render)
              .catch(() => render());
            return;
          }
          if (p && p.message) busy = { message: p.message };
          if (open && !showIgnored) render();
        });
      }

      // 兜底轮询。**自停** —— 扩展被重载之后,旧页面里的脚本会变成孤儿,
      // 它的定时器还在跑但什么也做不了,只会一直报 "Extension context invalidated"。
      const timer = window.setInterval(() => {
        if (!alive()) {
          window.clearInterval(timer);
          return;
        }
        onChange();
        checkStuckJob();
      }, 5000);
    } catch (e) {
      showFatal(e);
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    mount,
    toggle,
    setOpen,
    render,
    reload,
    scanNoticeAction,
    _internals: {
      TABS,
      CAP,
      relationText,
      ago,
      checkStuck: checkStuckJob,
      setBusy: (v) => {
        jobBusy = !!v;
      },
    },
  };
});
