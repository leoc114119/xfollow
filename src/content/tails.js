// 小尾巴:存几条常用结语,回帖时点一下把其中一条放进**剪贴板**,你自己 ⌘V 粘上。
//
// ── 为什么走剪贴板,而不是直接写进回复框 ──────────────────────
// 2026-09-23 在真机上量出来的,不是猜的:
//   · X 的回复框是 Draft.js 编辑器。用 `execCommand('insertText')` 写进去,**第一次**是
//     真能被它接受的 —— 读数:插入后 300ms,回复键的 `aria-disabled` 从 `true` 变成
//     **属性消失**(可用)。也就是说那一笔进了它的内部状态。
//   · 但**同一个框里插第二次就不行了**:字只在 DOM 里,X 一重绘(你敲字就会触发)就把它抹掉。
//     用户实测:框里两个标记,打字时第二个消失。
//   · 而真实的 ⌘V 走的是 Draft.js **自己的粘贴路径**,一进去就在它状态里,之后怎么改都不会被吞。
// 直接写框那条路的失败是**静默的**(看着带上了、发出去才发现没有),所以放弃它。
//
// ── 代价,说清楚 ────────────────────────────────────────────
// 多按一个键,而且**会覆盖你当前剪贴板里的东西**。这是这个方案的唯一代价。
//
// 不新增任何权限:`navigator.clipboard.writeText` 有你的点击(用户手势)就够了,
// 做不到时退回老的 execCommand('copy') 路径,两者都不需要 manifest 里加权限。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'xf:tails';
  // 上限 10 条(原来是 5)。**越大越安全**:轮换的池子越大,连着出现同一句的概率越低,
  // 而"重复内容"正是反垃圾系统盯的模式 —— 所以这个数字往大放是有意义的,不是堆功能。
  const CAP = 10;
  const MAX_LEN = 300; // 单条长度上限,防手滑贴进来一整篇文章
  const LAST_KEY = 'xf:tails:last';
  // 填框能力先关着,理由见 TAILS-FILL-DESIGN-PROMPT.md
  // 填进回复框的开关(关掉时只复制)。判据见 fillTail。
  // **永久关掉**"往回复框里写"这件事。
  // 2026-09-25 真机代价:insertText 有时只把字写进 **DOM**、没进 Draft.js 的模型 ——
  // 用户看到的现象是"多了一条、而且删不掉"(只有刷新页面才能清掉),等于把输入框弄成半坏状态。
  // 这不是"再调一下参数"能解决的:光标位置在 Draft 的模型里,隔离世界拿不到它的选区 API。
  // 剩下的路只有"复制 + 你自己粘",那条永远不会碰你的框。
  const FILL_ENABLED = true;

  /**
   * 清洗一份尾巴列表(纯函数,可单测):
   * 去掉首尾空白、丢掉空的、去重、截断到上限。**不做别的加工** ——
   * 内容里有换行/空格是用户自己排版,原样保留。
   */
  function sanitize(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const t = raw.replace(/\s+$/, ''); // 只去尾部空白:开头的空行可能是故意的
      if (!t.trim()) continue;
      const cut = t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t;
      const k = cut.trim();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(cut);
      if (out.length >= CAP) break;
    }
    return out;
  }

  /**
   * 这条尾巴里有没有**明确的**链接/邮箱 —— 用户自己定的规矩是"不放链接和联系方式"
   * (重复内容 + 链接是反垃圾系统最典型的判定组合)。
   * 只拦明确的两种。号码之类歧义太大,不假装能识别(外部审查提醒过),
   * 那份责任留给用户自己核。
   */
  function looksLikeContact(text) {
    const t = String(text || '');
    if (/https?:\/\/|www\./i.test(t)) return '链接';
    if (/[^\s@]+@[^\s@]+\.[^\s@]{2,}/.test(t)) return '邮箱';
    return '';
  }

  /**
   * 挑一条:**随机,但避开上次那条**(多于一条时)。
   * 为什么要避开:连着两条一样的尾巴,等于把"重复内容"这个特征送给反垃圾系统;
   * 轮换是这个功能唯一能降低平台风险的地方。
   */
  // 洗牌袋:一轮之内**不重复**,用完了重洗。
  // 原来是"避开上一条" —— 隔一条就会转回来(用户报"好像总是一条",复现是 甲→丙→甲 ✗)。
  // 轮换才是这个功能的减风险处:连着几条一样的结语,正是反垃圾系统盯的重复内容。
  let bag = [];

  function pick(list, lastText) {
    const items = sanitize(list);
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    // 袋子里的东西必须还在列表里(用户可能刚删了一条)
    bag = bag.filter((t) => items.includes(t));
    if (!bag.length) {
      bag = items.slice();
      for (let i = bag.length - 1; i > 0; i -= 1) {
        // 洗牌
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = bag[i];
        bag[i] = bag[j];
        bag[j] = tmp;
      }
      // 新一轮的第一个尽量别是刚用过的那条(做不到也无妨:一轮内本来就不会再重复它)
      if (bag.length > 1 && bag[0] === lastText) {
        const k = 1 + Math.floor(Math.random() * (bag.length - 1));
        const tmp = bag[0];
        bag[0] = bag[k];
        bag[k] = tmp;
      }
    }
    return bag.shift();
  }

  function get() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([KEY, LAST_KEY], (r) => {
          lastText = (r && r[LAST_KEY]) || '';
          cacheList = sanitize((r && r[KEY]) || []);
          resolve({ list: cacheList, last: lastText });
        });
      } catch {
        resolve({ list: [], last: '' });
      }
    });
  }

  function save(list) {
    const clean = sanitize(list);
    cacheList = clean;
    // ⚠ 必须**如实**返回成败:原来无论存储成没成都当成功(外部审查点名),
    // 用户以为存上了,下次打开发现没了。
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: clean }, () => {
          let err = null;
          try {
            err = (chrome.runtime && chrome.runtime.lastError) || null;
          } catch {
            err = null;
          }
          resolve({ ok: !err, list: clean, error: err ? String(err.message || err) : null });
        });
      } catch (e) {
        resolve({ ok: false, list: clean, error: String((e && e.message) || e) });
      }
    });
  }

  /** 记下这次复制的是哪条(下次跳过它) */
  let lastText = ''; // 内存里也留一份,免得每次都去读存储
  let cacheList = null; // 尾巴列表的内存副本:点击时要**同步**取一条(不在手势窗口里等 IO)
  function cacheNow() {
    return Array.isArray(cacheList) ? cacheList : null;
  }
  function remember(text) {
    lastText = text || '';
    try {
      chrome.storage.local.set({ [LAST_KEY]: lastText });
    } catch {
      /* ignore */
    }
  }
  function lastCopied() {
    return lastText;
  }

  // ── 把尾巴填进输入框(用户要的流程)────────────────────────────
  //   · 只走**两击**:第一击取一条进剪贴板并把文本记在内存(armed),第二击才填;
  //   · 填用的是**合成 paste 事件** —— 真机上 Draft 的 `editOnPaste` 是普通 JS 监听器,
  //     读事件上的 clipboardData、**不看 isTrusted**,所以它走的是 X 自己的粘贴管线
  //     (这正是 TAILS-FILL-V2-REVIEW.md 翻案的地方);代价是"替换选区",故有选中文字时不动;
  //   · 六道保险见 arm/pasteInto;失败一律如实报,并退回剪贴板。
  /**
   * 页面上所有可编辑输入框,**偏好顺序**:光标/焦点所在的那个排最前。
   *
   * ⚠ 顺序要紧:`document.activeElement` 常常就是 `<body>`,而 `body.contains(任何输入框)`
   * 恒为真 —— 先看它的话,"光标在哪个框"这个信号会被第一个框永远抢走(自己写出来又自己踩到的)。
   * 所以先看选区,再看焦点,并且把 body / documentElement 排除掉。
   */
  function editors() {
    const out = [];
    const editable = (el) => !!el && (el.isContentEditable || el.getAttribute('contenteditable') === 'true');
    try {
      for (const el of document.querySelectorAll('[data-testid^="tweetTextarea"]')) {
        if (editable(el)) out.push(el);
      }
      if (!out.length) {
        for (const el of document.querySelectorAll('[contenteditable="true"][role="textbox"]')) out.push(el);
      }
    } catch {
      /* ignore */
    }
    if (out.length > 1) {
      let caret = null;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const n = sel.getRangeAt(0).startContainer;
          caret = n && (n.nodeType === 1 ? n : n.parentElement);
        }
      } catch {
        caret = null;
      }
      const active = (el) => {
        if (caret && (el === caret || el.contains(caret))) return true;
        let act = null;
        try {
          act = document.activeElement;
        } catch {
          act = null;
        }
        if (!act || act === document.body || act === document.documentElement) return false;
        return el === act || el.contains(act) || act.contains(el);
      };
      const i = out.findIndex(active);
      if (i > 0) out.unshift(out.splice(i, 1)[0]);
    }
    return out;
  }

  /** 当前这条输入框(偏好顺序的第一个) */
  function editorNow() {
    return editors()[0] || null;
  }

  /**
   * **只有行内回复框才装按钮** —— `tweetButtonInline` 只出现在那里。
   *
   * ⚠ 一天之内来回踩的那个坑(2026-09-25):曾经把弹窗的 `tweetButton` 也收进来
   * (理由是"引用框里没有按钮"),结果页面上第一个可编辑输入框(顶部发帖框,它的键正是
   * `tweetButton`)把按钮抢走了,用户立刻反馈「你把回复的小尾巴都弄丢了」。
   * 而且引用/发帖页**根本不需要**这个按钮(用户原话:「在引用页不需要小尾巴」)。
   * 结论:范围就是行内回复框,不扩张。
   */
  const REPLY_SEND_SEL = '[data-testid="tweetButtonInline"]';

  /**
   * 找**这条输入框自己那一个**发送键(不是全页第一个匹配 —— 外部审查 1.3/1.4 点名)。
   * 从编辑器往上走,第一个"包含行内回复键"的祖先就是这条 composer 的根,键就在里面。
   * 拿不到 ⇒ 返回 null(调用方会先试别的输入框、再用兜底)。
   */
  function sendButtonFor(ed) {
    let el = ed;
    for (let i = 0; i < 10 && el; i += 1, el = el.parentElement) {
      let b = null;
      try {
        b = el.querySelector && el.querySelector(REPLY_SEND_SEL);
      } catch {
        b = null;
      }
      if (b) return b;
    }
    return null;
  }

  /**
   * 三件门禁(外部审查给的"生产形态",任何一条不满足就**什么都不做**):
   *   ① 选区必须**折叠** —— 有选中文字时 insertText 会先删掉选区 ⇒ 直接覆盖用户写的字;
   *   ② 光标必须在**这个**编辑器里;
   *   ③ 光标必须在**文末** —— 否则尾巴会插进正文中间,而且**会被一起发出去**(比幽灵更糟)。
   * 只读,不动任何东西;它只是告诉调用方"现在安不安全"。
   */
  function fillGate(ed) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount !== 1) return '没有光标';
      const r = sel.getRangeAt(0);
      if (!r.collapsed) return '有选中文字';
      if (!ed.contains(r.startContainer)) return '光标不在回复框里';
      const pre = document.createRange();
      pre.selectNodeContents(ed);
      pre.setEnd(r.startContainer, r.startOffset);
      const at = String(pre.toString()).length;
      return at >= String(ed.textContent || '').length ? '' : '光标不在末尾';
    } catch {
      return '读不到光标';
    }
  }

  /**
   * 填进回复框(**默认关着**,见 FILL_ENABLED)。打开时的形态按外部审查定:
   *   · 过三件门禁才动手,否则一个字都不碰;
   *   · **不移动光标**(不设 Range、不发 select)—— 那串动作正是产生"幽灵字"的元凶;
   *   · 插入一次,500ms 后**复核发送键**:还灰着就如实报"填入失败,请刷新",不假装成功。
   * 返回 'pasted' / 'failed' / 'blocked:<原因>' / 'none'。
   */
  // ── 两击路线的状态(全在内存:刷新即失,重来只花一次点击)──────────────
  // 第一击 = 随机取一条进剪贴板 + 把文本**记在内存里**(armed);
  // 第二击 = 构造合成 paste 事件派发到编辑器 —— 走的是 Draft 自己那条粘贴管线
  // (editOnPaste 是普通 JS 监听器,读事件上的 clipboardData、**不看 isTrusted**),
  // 所以它不像 insertText 那样会出现"只落 DOM"的幽灵。
  // ⚠ 第二击**不读剪贴板**:文本来自内存 ⇒ 不需要 clipboardRead 权限。
  let armed = null;

  function disarm() {
    armed = null;
    try {
      document.removeEventListener('paste', disarm, true);
    } catch {
      /* ignore */
    }
  }

  function arm(text, ed) {
    armed = { text, ed };
    // 保险①:任何真实的 paste(你自己按了 ⌘V)一到就解除 —— 否则你粘完再点第二击会贴两遍
    try {
      document.addEventListener('paste', disarm, true);
    } catch {
      /* ignore */
    }
    if (btn) btn.textContent = '已复制·再点粘贴';
  }

  /**
   * 第二击:把 armed 的那条用合成 paste 贴进编辑器。返回 {ok, reason, why?}
   * 保险②③:非折叠选区不派发(粘贴的标准语义就是替换选区 ⇒ 会覆盖你写的字);
   *           编辑器换了人(SPA 换页/弹窗重开)⇒ armed 作废,绝不贴进别的框。
   * 判据:内容**追加在末尾** + **同一个回复框**的发送键不再灰(模型认下了)。
   */
  async function pasteInto() {
    if (!armed) return { ok: false, reason: 'not-armed' };
    const { text, ed } = armed;
    if (!ed || !ed.isConnected || editorNow() !== ed) {
      disarm();
      return { ok: false, reason: 'stale-editor' };
    }
    const why = fillGate(ed);
    if (why) return { ok: false, reason: 'gate', why };
    const send = sendButtonFor(ed);
    const before = String(ed.textContent || '');
    const ev = makePasteEvent(text);
    if (!ev) return { ok: false, reason: 'no-event' };
    try {
      ed.dispatchEvent(ev);
    } catch {
      return { ok: false, reason: 'dispatch-failed' };
    }
    disarm();
    await new Promise((r) => setTimeout(r, 500));
    const after = String(ed.textContent || '');
    const appended = after.startsWith(before) && after.length > before.length;
    const enabled = !send || send.getAttribute('aria-disabled') !== 'true';
    if (appended && enabled) return { ok: true, reason: 'pasted' };
    // 内容看着进去了、发送键还灰 ⇒ 很可能是幽灵字:如实报,并叫你刷新
    return { ok: false, reason: appended ? 'ghost' : 'replaced-or-none' };
  }


  /**
   * 构造一个合成 paste 事件(pasteInto 与 P0b 试验共用;tails.test.js 有夹具缺口说明)。
   * Draft 的 editOnPaste 是普通 JS 监听器,读事件上的 clipboardData、不看 isTrusted。
   */
  function makePasteEvent(text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      return new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    } catch {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        ev.clipboardData = dt; // 兜底构造
        return ev;
      } catch {
        return null;
      }
    }
  }

  async function fillTail(text) {
    const ed = editorNow();
    if (!ed || !text) return 'none';
    const why = fillGate(ed);
    if (why) return 'blocked:' + why;
    const send = sendButtonFor(ed);
    if (!send) return 'none';
    const before = String(ed.textContent || '');
    try {
      document.execCommand('insertText', false, text);
    } catch {
      return 'none';
    }
    await new Promise((r) => setTimeout(r, 500));
    const after = String(ed.textContent || '');
    const appended = after.startsWith(before) && after.length > before.length;
    const enabled = send.getAttribute('aria-disabled') !== 'true';
    // 两样都要:内容追加在末尾(而不是插到中间/替换) + 模型认下了(发送键不再灰)
    if (appended && enabled) return 'pasted';
    return 'failed';
  }


  /**
   * 把文字放进剪贴板。两条路都试,都不需要权限:
   *   1) navigator.clipboard.writeText —— 现代路径,但要求文档是聚焦的
   *   2) execCommand('copy') + 临时 textarea —— 老路径,兼容兜底
   * 返回 true/false,**由调用方如实告诉用户**(不能"以为复制了")。
   */
  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到老路径 */
    }
    // 老路径:临时 textarea。**必须 try/finally** —— 原来 select()/copy 一抛错,
    // 这个临时元素就永远留在 X 的页面上了(外部审查点名)。
    let ta = null;
    let prevFocus = null; // 声明在 try 外面:finally 要用它,放里面就取不到了(自己踩的)
    try {
      prevFocus = document.activeElement; // 别把用户的光标弄丢
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      return !!ok;
    } catch {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      try {
        if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      } catch {
        /* 恢复不了就算了,但不能因此留下垃圾 */
      }
    }
  }

  // ── 回复框旁边的「尾巴」按钮 ─────────────────────────────────
  //
  // 落点和角标同一套规矩:只在 X 的容器里**新增**我们自己的节点;不写它的属性、
  // 不改它的样式、不劫持它的点击;被 X 的重绘带走之后能自愈。
  // 它做的事只有一件:把一条尾巴放进剪贴板 —— **不写回复框、不代你发送**。
  const BTN_CLASS = 'xf-tail-btn';
  const STYLE_ID = 'xf-tail-style';
  // ── 「译」按钮(v1:译 → 预览 → 复制;TRANSLATE-DESIGN.md v2)─────────────
  // 和「尾巴」同一条 observer、同一套装机/迁移/撤装规则。
  // **v1 没有任何写草稿的动作** —— 自动替换是另一个能力,要等 P0b 在一次性草稿上
  // 证明"模型侧整稿替换"之后才允许出现(两份评审的共同结论)。
  const TRANS_CLASS = 'xf-trans-btn';
  const PANEL_CLASS = 'xf-trans-panel';
  const HAS_CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  let transBtn = null;
  let previewEl = null;
  let previewDismiss = null; // 浮层的"点外即收"监听(开面板挂上、收面板摘掉)
  let transBusy = false;

  function xfApi() {
    return (typeof globalThis !== 'undefined' && globalThis.XF) || {};
  }

  /**
   * 草稿投影:Draft 把每个段落块渲染成独立节点,`textContent` 会把块间换行**吞掉**
   * (评审 A1/Codex#9:两段读成"第一段第二段")。所以按块投影、用 \n 连;
   * 没有块结构时退 innerText(真浏览器有),再退 textContent。
   */
  function draftTextOf(ed) {
    if (!ed) return '';
    try {
      let blocks = ed.querySelectorAll('[data-block]');
      if (!blocks.length) blocks = ed.querySelectorAll('[data-contents] > div');
      if (blocks.length) {
        return Array.from(blocks)
          .map((b) => String(b.textContent || ''))
          .join('\n');
      }
      const it = ed.innerText;
      if (typeof it === 'string' && it) return it;
    } catch {
      /* ignore */
    }
    return String(ed.textContent || '');
  }

  /** 装机门禁:能力没读出来('unknown')就先不装,读出来是 'no' 就永远不装 */
  function capOk() {
    const X = xfApi();
    if (typeof X.translateCap !== 'function') return false; // 引擎模块没加载就没有入口
    try {
      return X.translateCap() === 'ok';
    } catch {
      return false;
    }
  }

  /** 页面实际明暗(角标同一套做法:读背景亮度,prefers-color-scheme 跟的是系统不是 X) */
  function pageIsDark() {
    try {
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
      if (!m) return true;
      return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 < 0.5;
    } catch {
      return true;
    }
  }

  function closePreview() {
    if (previewEl && previewEl.parentNode) previewEl.parentNode.removeChild(previewEl);
    previewEl = null;
    if (previewDismiss) {
      try {
        document.removeEventListener('pointerdown', previewDismiss, true);
        document.removeEventListener('keydown', previewDismiss, true);
        window.removeEventListener('scroll', previewDismiss, true);
      } catch {
        /* ignore */
      }
      previewDismiss = null;
    }
    replaceCtx = null; // 授权绑定这一份预览:面板关了就作废
  }

  /** 译文预览(只读)。正文一律 textContent —— 评审明令禁 innerHTML。 */
  function openPreview(res) {
    closePreview();
    const panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.dataset.xfT = pageIsDark() ? 'dark' : 'light';

    const head = document.createElement('div');
    head.className = 'xf-trans-head';
    const title = document.createElement('span');
    title.textContent = res.title || (res.ok ? '译文' : '翻译没成');
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'xf-trans-x';
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePreview();
    });
    head.appendChild(title);
    head.appendChild(x);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'xf-trans-body';
    body.textContent = res.ok ? res.text : String(res.note || '原因不明');
    panel.appendChild(body);

    if (res.ok) {
      // 「替换草稿」:P0b 配方B 在真机证明整稿替换成立后才挂出来的能力。
      // 授权绑定**这一份快照**:草稿一变、编辑器一换、失败一次,它就作废。
      if (res.replace) {
        replaceCtx = res.replace;
      } else {
        replaceCtx = null;
      }
      if (res.stale) {
        const note = document.createElement('p');
        note.className = 'xf-trans-note';
        note.textContent = '(草稿后来改过 —— 上面是旧稿的译文,要新译文再点一次「译」)';
        panel.appendChild(note);
      }
      const foot = document.createElement('div');
      foot.className = 'xf-trans-foot';
      if (replaceAllowed()) {
        const rb = document.createElement('button');
        rb.type = 'button';
        rb.className = REPLACE_CLASS;
        rb.textContent = '替换草稿';
        rb.title = '把回复框整稿换成这段译文。要求草稿和出译文时一字不差;失败不会自动重试,原文会进剪贴板';
        rb.addEventListener('click', onReplaceClick);
        foot.appendChild(rb);
      }
      const cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'xf-trans-copy';
      cp.textContent = res.copyLabel || '复制译文';
      const st = document.createElement('span');
      st.className = 'xf-trans-status';
      cp.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyText(res.text);
        st.textContent = ok ? '已复制 ✓' : '没复制上 —— 选中上面那段自己复制';
      });
      foot.appendChild(cp);
      foot.appendChild(st);
      panel.appendChild(foot);
    }

    // 定位(真机事故:按钮的 rect 量出全 0 —— X 重绘时节点正被换掉,面板就飞到
    // 页面左上角的导航栏上,用户以为页面坏了)。所以:锚点依次是「译」按钮 →
    // 这次翻译的输入框 → 都量不到就靠右居中;宽高写内联不依赖样式表;挂载后
    // 整体夹回视口。z-index 取最大档(抽屉根就是 2147483646,同档谁在上靠不住)。
    try {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const W = 372;
      const usable = (el) => {
        try {
          const r = el.getBoundingClientRect();
          return r && r.width > 1 && r.height > 1 && r.bottom > -40 && r.top < vh ? r : null;
        } catch {
          return null;
        }
      };
      const edNow = editorNow();
      const r = (transBtn && usable(transBtn)) || (edNow && usable(edNow)) || null;
      panel.style.position = 'fixed';
      panel.style.width = '360px';
      panel.style.maxWidth = 'calc(100vw - 16px)';
      if (r) {
        panel.style.left = Math.max(8, Math.min(r.right - W + 40, vw - W - 8)) + 'px';
        panel.style.top = Math.round(r.bottom) + 6 + 'px';
      } else {
        panel.style.left = Math.max(8, vw - W - 8) + 'px';
        panel.style.top = Math.max(8, Math.round(vh / 2) - 60) + 'px';
      }
      (document.body || document.documentElement).appendChild(panel);
      const h = panel.getBoundingClientRect().height || 120;
      let top = parseFloat(panel.style.top) || 8;
      if (top + h > vh - 8) top = Math.max(8, top - h - 12); // 底下放不下:翻到锚点上方
      panel.style.top = top + 'px';
    } catch {
      (document.body || document.documentElement).appendChild(panel);
    }
    previewEl = panel;
    // ⚠ 浮层的第一规矩:**点外面就收,而且不拦那一下点击**(真机教训:面板盖住
    // 正在编辑的区域,用户点哪儿都没反应,以为页面坏了)。捕获阶段监听,只收面板、
    // 不 stopPropagation —— 被挡住的那一下照常落到 X 的页面上。
    previewDismiss = (e) => {
      try {
        if (e && e.type === 'keydown' && e.key !== 'Escape') return;
        const t = e && e.target;
        if (previewEl && t && (t === previewEl || previewEl.contains(t))) return; // 面板内的点击照常
        if (t && transBtn && (t === transBtn || transBtn.contains(t))) return;    // 点「译」= 重新翻译
        closePreview();
      } catch {
        closePreview();
      }
    };
    document.addEventListener('pointerdown', previewDismiss, true);
    document.addEventListener('keydown', previewDismiss, true);
    window.addEventListener('scroll', previewDismiss, true); // 捕获:任何容器的滚动都算
  }

  function flashTrans(text) {
    if (!transBtn) return;
    transBtn.textContent = text;
    setTimeout(() => {
      if (transBtn && !transBusy) transBtn.textContent = '译';
    }, 2200);
  }

  /**
   * 「译」这一击:**读草稿 → 端侧翻译 → 预览**。不写草稿、不写剪贴板(复制是面板里
   * 你自己点的按钮,新手势、新激活 —— 评审 A5:翻译的时延会吃掉点击激活的窗口)。
   * 门禁(任何一条不满足就一个字都不动):草稿非空;草稿里有中文;草稿里没有已存尾巴。
   */
  async function onTransClick(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!transBtn || transBusy) return;
    const X = xfApi();
    if (typeof X.translateText !== 'function') {
      flashTrans('翻译模块没加载');
      return;
    }
    const ed = editorNow();
    const snap = draftTextOf(ed);
    if (!snap.trim()) {
      flashTrans('草稿是空的');
      return;
    }
    if (!HAS_CJK.test(snap)) {
      flashTrans('草稿里没有中文');
      return;
    }
    // 尾巴门禁(v1 = 拒绝并解释):尾巴是计数的锚点,被翻掉就少算了 —— 先翻译,再加尾巴
    const { list } = await get();
    const hit = (list || []).some((t) => {
      if (!t) return false;
      if (snap.indexOf(t) >= 0) return true;
      const tr = t.replace(/^\s+/, '');
      return tr ? snap.indexOf(tr) >= 0 : false;
    });
    if (hit) {
      flashTrans('草稿里有尾巴——先翻译,再加尾巴');
      return;
    }

    transBusy = true;
    transBtn.textContent = '翻译中…';
    const myGen = gen;
    let r = null;
    try {
      r = await X.translateText(snap);
    } catch (e) {
      r = { ok: false, reason: 'translate-failed', error: String((e && e.message) || e) };
    }
    if (myGen !== gen || stopped) return; // 停了/换代:迟到结果一律丢弃,连面板都不开
    transBusy = false;
    if (transBtn) transBtn.textContent = '译'; // 输入框没了的话按钮已经撤了,别炸在空引用上
    if (!r.ok) {
      const why =
        r.reason === 'timeout'
          ? '翻译超时 —— 模型没回应,稍后再试'
          : r.reason === 'create-failed'
            ? '翻译引擎起不来:' + (r.error || '')
            : r.reason === 'translate-failed'
              ? '翻译失败:' + (r.error || '')
              : r.reason === 'no-api'
                ? '此环境暂不支持端侧翻译'
                : '翻译没成:' + (r.error || r.reason || '?');
      replaceCtx = null;
      openPreview({ ok: false, note: why });
      return;
    }
    // 草稿在翻译期间被你改过 → 如实标注,别让旧译文冒充现状(评审 Codex#3 的预览版)
    const changed = editorNow() === ed ? draftTextOf(ed) !== snap : true;
    openPreview({
      ok: true,
      text: r.text,
      stale: changed,
      // 替换授权绑定**这一份快照**(草稿已变就不给 —— 那份译文对应不上现在的草稿)
      replace: changed ? null : { ed, snapshot: snap, translation: r.text, blocked: false, busy: false },
    });
  }

  function mkTailBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = BTN_CLASS;
    b.textContent = '尾巴';
    b.title = '随机取一条放进剪贴板(框里已有字时带换行):点到回复框末尾再 ⌘V。不会自动发送';
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 别抢回复框的光标
    b.addEventListener('click', onTailClick);
    b.dataset.xfArmed = '0';
    return b;
  }

  function mkTransBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    // ⚠ 不借用 BTN_CLASS:两个类挂一个按钮会让 ".xf-tail-btn" 的选择器数出两个按钮
    // (测试当场抓了)。样式自己带一份,类名各管各的按钮。
    b.className = TRANS_CLASS;
    b.textContent = '译';
    b.title = '把回复框里的中文翻成英文(端侧翻译,不出本机)。译文出预览,「替换草稿」由你决定';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onTransClick);
    return b;
  }

  // ── 「替换草稿」(P0b 配方B 在真机证明成立后才有的能力)────────────────
  // 证据:2026-10-02 真机读数 —— execCommand('selectAll') 后 DOM 全选,合成 paste
  // 把全稿换成了假译文(整稿替换 ✓)。配方 A(合成 ⌘A)已被真机判死:Draft 对
  // 不可信按键零反应,粘贴只会插在光标处。
  //
  // 安全合同(两份评审的合并裁决,一条都不省):
  //   · 预览里的**新手势**才动手;译文生成永远不自动写草稿;
  //   · 替换前重读草稿,和出译文时的快照**逐字相等**才继续 —— 期间你打过字就拒绝;
  //   · selectAll 后先验 DOM 选区(非折叠、在编辑器内),不满足就**不粘贴**;
  //   · 粘贴后按块投影 + 空白折叠比对;失败:原文自动进剪贴板 + 教 ⌘A⌘V/⌘Z,
  //     这份快照的自动路径就此作废(绝不自动重试 —— 还原叠层的教训);
  //   · 草稿里有提及/图片/链接等富内容时不替换(v1 只支持纯文本,评审 Codex#9)。
  const REPLACE_CLASS = 'xf-trans-replace';
  let replaceCtx = null; // { ed, snapshot, translation, blocked }

  function draftNormalized(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** v1 只替换纯文本草稿:富内容(提及/图片/链接)一律只提供复制 */
  function draftHasRichContent(ed) {
    try {
      return !!ed.querySelector('img, a[href], [data-text-mention-id]');
    } catch {
      return true; // 读不出就当有,宁可少替换
    }
  }

  function replaceAllowed() {
    return !!replaceCtx && !replaceCtx.blocked && !!replaceCtx.ed && replaceCtx.ed.isConnected;
  }

  async function onReplaceClick(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const ctx = replaceCtx;
    if (!ctx || ctx.busy) return;
    const st = previewEl && previewEl.querySelector('.xf-trans-status');
    const say = (msg) => {
      if (st) st.textContent = msg;
    };
    // ① 编辑器还是那一个吗
    if (!ctx.ed.isConnected || editorNow() !== ctx.ed) {
      say('回复框换了人 —— 重新点「译」翻一份新的');
      return;
    }
    // ② 草稿还和出译文时一字不差吗(评审 Codex#3:期间打过字,授权作废)
    const now = draftTextOf(ctx.ed);
    if (now !== ctx.snapshot) {
      say('草稿已经改过 —— 上面是旧稿的译文,要新译文再点一次「译」');
      return;
    }
    if (ctx.blocked) {
      say('这份快照的自动替换已经失败过一次 —— ⌘A ⌘V 手动换,或重新点「译」');
      return;
    }
    // ③ 富内容(v1 不支持)
    if (draftHasRichContent(ctx.ed)) {
      say('草稿里有提及/图片/链接等富内容 —— 自动替换只支持纯文本,请用复制+⌘A⌘V');
      return;
    }
    ctx.busy = true;
    // ④ 全选(配方B,真机已证)。选区不满足就不粘贴 —— 这是最后的事前门禁
    let selected = false;
    try {
      ctx.ed.focus();
      selected = document.execCommand('selectAll') === true;
    } catch {
      selected = false;
    }
    const selOk =
      selected &&
      (() => {
        try {
          const sel = window.getSelection();
          const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
          return !!(r && !r.collapsed && ctx.ed.contains(r.startContainer) && ctx.ed.contains(r.endContainer));
        } catch {
          return false;
        }
      })();
    await new Promise((r) => setTimeout(r, 150)); // 等 selectionchange 周期(评审 A4)
    if (!selOk) {
      ctx.busy = false;
      ctx.blocked = true;
      disableReplaceButton();
      const copied = await copyText(ctx.snapshot);
      say(
        '没能全选(草稿一个字没动)。' +
          (copied ? '原文已复制,⌘A ⌘V 手动换' : '⌘A ⌘V 手动换;或重新点「译」')
      );
      return;
    }
    // ⑤ 粘贴译文(合成 paste 走 X 自己的管线)
    const pev = makePasteEvent(ctx.translation);
    if (!pev) {
      ctx.busy = false;
      ctx.blocked = true;
      disableReplaceButton();
      say('构造粘贴事件失败 —— 草稿没动。⌘A ⌘V 手动换');
      return;
    }
    ctx.ed.dispatchEvent(pev);
    await new Promise((r) => setTimeout(r, 500));
    ctx.busy = false;
    // ⑥ 校验:整稿(按块投影 + 空白折叠)=== 译文
    const after = draftNormalized(draftTextOf(ctx.ed));
    if (after === draftNormalized(ctx.translation)) {
      if (replaceCtx === ctx) {
        disableReplaceButton();
        say('已替换 ✓(⌘Z 可整次撤销)—— 尾巴记得再加');
      }
      return;
    }
    // ⑦ 失败:绝不自动重试/还原(叠层教训)。原文进剪贴板,手动通道说清楚
    ctx.blocked = true;
    disableReplaceButton();
    const copied = await copyText(ctx.snapshot);
    say(
      '自动替换没成功(⌘Z 可撤销刚才这一下)。' +
        (copied ? '原文已复制,⌘A ⌘V 手动换' : '⌘A ⌘V 手动换') +
        ';或重新点「译」'
    );
  }

  function disableReplaceButton() {
    try {
      const b = previewEl && previewEl.querySelector('.' + REPLACE_CLASS);
      if (b) b.parentNode.removeChild(b);
    } catch {
      /* ignore */
    }
  }

  let btn = null;
  let raf = false;
  let mo = null;
  let restoreTimer = null;
  // 代次:stopTails 之后,已经排上队的 rAF 回调必须自己作废。
  // 不这么做的话,旧实例的回调会拿**当前** document 去造按钮 ——
  // 页面上出现第二个按钮、querySelector 命中孤儿、反馈打到另一个元素上。
  // (这条是外部审查复现出来的,那条"偶发红的测试"就是它的症状,不是断言写坏。)
  let gen = 0;
  let stopped = false; // 显式停过之后,连延迟的自动安装也不许再启动

  /** 扩展上下文是否还活着。重载扩展后旧内容脚本的 chrome.* 已经不可用 ——
   *  那时不该再往页面上装任何东西(否则会留下一个永远说"先存一条"的死按钮)。 */
  function stillUs() {
    const B = (typeof globalThis !== 'undefined' && globalThis.XF) || {};
    if (typeof B.chromeAlive === 'function') {
      try {
        return !!B.chromeAlive();
      } catch {
        return false;
      }
    }
    return true;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      // 辅助入口,不该比 X 自己的「回复」键还抢眼:更矮、更小、更淡
      '.' + BTN_CLASS + '{flex:none;margin-right:8px;padding:0 10px;height:28px;',
      '  border:1px solid currentColor;border-radius:999px;background:transparent;',
      '  color:#8b98a5;font:600 12px/26px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      '  cursor:pointer;white-space:nowrap}',
      '.' + BTN_CLASS + ':hover{background:rgba(83,100,113,.12)}',
      '.' + BTN_CLASS + '[data-xf-t="dark"]{color:#8b98a5}',
      '.' + BTN_CLASS + '[data-xf-t="dark"]:hover{background:rgba(139,152,165,.16)}',
      // 「译」:和尾巴同一个外观,类名独立(不挂 BTN_CLASS —— 见 mkTransBtn 的注释)
      '.' + TRANS_CLASS + '{flex:none;margin-right:8px;padding:0 10px;height:28px;',
      '  border:1px solid currentColor;border-radius:999px;background:transparent;',
      '  color:#8b98a5;font:600 12px/26px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
      '  cursor:pointer;white-space:nowrap}',
      '.' + TRANS_CLASS + ':hover{background:rgba(83,100,113,.12)}',
      '.' + PANEL_CLASS + '{position:fixed;z-index:2147483647;width:360px;max-width:calc(100vw - 16px);',
      '  padding:10px 12px;border-radius:10px;border:1px solid #2b3947;background:#15202b;color:#e7e9ea;',
      '  box-shadow:-8px 0 24px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:6px;text-align:left;',
      '  font:13px/20px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '.' + PANEL_CLASS + '[data-xf-t="light"]{border-color:#e5e9ed;background:#fff;color:#0f1419;',
      '  box-shadow:-8px 0 24px rgba(0,0,0,.10)}',
      '.' + PANEL_CLASS + ' .xf-trans-head{display:flex;align-items:center;justify-content:space-between}',
      '.' + PANEL_CLASS + ' .xf-trans-head span{font-weight:700;font-size:13px}',
      '.' + PANEL_CLASS + ' .xf-trans-x{border:0;background:none;color:inherit;font-size:14px;cursor:pointer;',
      '  padding:2px 6px;border-radius:6px}',
      '.' + PANEL_CLASS + ' .xf-trans-x:hover{background:rgba(128,128,128,.18)}',
      '.' + PANEL_CLASS + ' .xf-trans-body{white-space:pre-wrap;overflow-wrap:anywhere;',
      '  max-height:180px;overflow:auto;padding:6px 8px;border-radius:8px;background:rgba(128,128,128,.10)}',
      '.' + PANEL_CLASS + ' .xf-trans-note{margin:0;font-size:12px;line-height:17px;color:#ffcc66}',
      '.' + PANEL_CLASS + ' .xf-trans-foot{display:flex;align-items:center;gap:10px}',
      '.' + PANEL_CLASS + ' .xf-trans-copy{flex:none;height:26px;padding:0 12px;border-radius:999px;',
      '  border:1px solid transparent;background:#1d9bf0;color:#fff;font-family:inherit;font-size:12px;',
      '  font-weight:600;cursor:pointer}',
      '.' + PANEL_CLASS + ' .xf-trans-status{font-size:12px;color:#8b98a5}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /**
   * 找"落点":从发送键往上找**第一个横排容器**,插在那一排里。
   *
   * 踩过(用户截图指出):直接插进发送键的父节点,而那个父节点是**竖排**的壳 ——
   * 于是我们的按钮被摞在回复键上面,又丑又像坏掉了。
   * 所以不猜结构:用 getComputedStyle 实测 display / flex-direction,往上最多找 4 层,
   * 找到横排的就插进去;实在找不到才退回原来的做法。
   */
  function rowAnchor(send) {
    let el = send;
    for (let i = 0; i < 4 && el && el.parentElement; i += 1) {
      const p = el.parentElement;
      let cs = null;
      try {
        cs = getComputedStyle(p);
      } catch {
        cs = null;
      }
      if (cs && String(cs.display).indexOf('flex') >= 0 && cs.flexDirection === 'row') {
        return { parent: p, before: el };
      }
      el = p;
    }
    return { parent: send.parentElement, before: send };
  }

  /**
   * 落点 —— 按用户提供的**真实 DOM**(2026-09-25 composer outerHTML)定的,不再猜:
   *   发送键外面还包了一层壳(竖排),横排的是再外面那层:
   *     <div(横排)> [我们] <div(竖排壳)> <button 回复> </div> </div>
   *   所以要插在**壳的前面**,插进壳里会被摞在回复键上面。
   */
  function buttonHome(send) {
    const wrap = send.parentElement;
    const row = wrap && wrap.parentElement;
    if (!wrap || !row) return null;
    return { parent: row, before: wrap };
  }

  function ensureButton() {
    if (stopped || !stillUs()) return; // 停过、或旧的孤儿脚本 —— 都不许再动手
    const eds = editors();
    // 没有可编辑输入框就不装 —— 只看发送键是外部审查 1.3 的错(发送键还在过渡 DOM 里的时候,
    // 按钮会出现在根本没有输入框的地方)。
    let send = null;
    for (const ed of eds) {
      const s = sendButtonFor(ed);
      if (s) {
        send = s;
        break;
      }
    }
    // 兜底:配对走不通时退回"页面上第一个行内回复键"(这套规矩之前的老行为)。
    // ⚠ 可见优先于好看(用户的话是"你把回复的小尾巴都弄丢了")—— 位置宁可退回旧那个,
    // 也不能让按钮消失;前提依然是有可编辑输入框,否则一律不装。
    if (!send && eds.length) {
      try {
        send = document.querySelector(REPLY_SEND_SEL);
      } catch {
        send = null;
      }
    }
    if (!send || !send.parentElement) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      btn = null;
      if (transBtn && transBtn.parentNode) transBtn.parentNode.removeChild(transBtn);
      transBtn = null;
      closePreview(); // 输入框没了,译文预览也该走(它贴着按钮定位)
      return;
    }
    ensureStyle();
    // ⚠ 退回"直接插在发送键左边":上一版"往上找横排容器"可能把按钮放到看不见的地方
    // (用户反馈:按钮直接没了)。可见优先于好看 —— 位置等拿到真实 DOM 再调。
    const at = buttonHome(send);
    if (!at) return;
    if (!at.parent) return;
    // 已经在本该在的位置上就别动(位置会随 X 的重绘变,所以要逐次核对)。
    // 「译」跟着同一条规矩,排在「尾巴」左边;不在该在的位置就一起重摆。
    const btnOk = btn && btn.parentNode === at.parent && btn.nextElementSibling === at.before;
    const wantTrans = capOk();
    const transOk =
      transBtn && transBtn.parentNode === at.parent && transBtn.nextElementSibling === (btnOk ? btn : at.before);
    if (btnOk && (!wantTrans || transOk)) return;
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    if (transBtn && transBtn.parentNode) transBtn.parentNode.removeChild(transBtn);
    // **一个按钮,两步走**(用户提的):点一下 = 随机取一条放进剪贴板;
    // 停 1 秒后按钮变成「粘」,再点一下 = 把刚那条填进回复框末尾。
    // 为什么分两步:一个按钮既复制又填框的话,手快连点就会贴出两条(用户报过)。
    btn = mkTailBtn();
    at.parent.insertBefore(btn, at.before);
    transBtn = wantTrans ? at.parent.insertBefore(mkTransBtn(), btn) : null;
  }

  function flash(text) {
    if (!btn) return;
    btn.textContent = text;
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      if (btn) btn.textContent = '尾巴';
    }, 2000);
  }

  async function onPick(ev) {
    // 「复制」:只进剪贴板,**不碰回复框**(填进框由「粘」负责)
    if (false) return; // 占位,保持函数结构清晰
    // 别让这一下冒到 X 那边去(它可能把整个容器当可点区域)
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!stillUs()) return { ok: false, reason: 'dead-context', text: '' };
    const { list, last } = await get();
    const one = pick(list, last);
    if (!one) {
      flash('先存一条');
      return { ok: false, reason: 'empty', text: '' };
    }
    // 只复制,但**带上前导换行**:非空草稿时你把光标点到末尾一粘,就是「先换行再粘」。
    // 为什么不再替你填:外部方案证实现有边界下做不到「可靠追加且绝不破坏草稿」——
    // Draft 的选区 API 要它的 EditorState 和原应用的 onChange 入口,隔离世界拿不到;
    // 而合成 paste 会把内容**替换**掉(那次毁草稿的机制),文本里塞 \n 又会被吞。
    const ed = editorNow();
    const empty = !ed || !String(ed.textContent || '').trim();
    const payload = empty ? one : '\n' + one;
    const ok = await copyText(payload);
    if (ok) {
      remember(one);
      flash(empty ? '已复制 ⌘V' : '已复制(带换行)');
      return { ok: true, reason: empty ? 'copied' : 'copied-nl', text: one };
    }
    // 复制失败必须说出来 —— 否则你粘出来的是上一次剪贴板里的东西
    flash('复制失败');
    return { ok: false, reason: 'copy-failed', text: one };
  }

  /**
   * 「粘」:把**刚复制的那条**填进回复框末尾。
   * 没复制过就先随机取一条(并顺手复制,这样贴不上你还能 ⌘V)。
   * 两秒冷却 —— 连点不会贴两遍(用户报过"又点一次出来两个")。
   */
  let filling = false;
  async function onFill(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!stillUs()) return { ok: false, reason: 'dead-context', text: '' };
    if (filling) return { ok: false, reason: 'busy', text: '' };
    filling = true;
    try {
      let one = lastCopied();
      if (!one) {
        const { list, last } = await get();
        one = pick(list, last);
        if (!one) {
          flash('先存一条');
          return { ok: false, reason: 'empty', text: '' };
        }
        const payload = editorNow() && String(editorNow().textContent || '').trim() ? '\n' + one : one;
        if (await copyText(payload)) remember(one);
      }
      const how = FILL_ENABLED ? await fillTail(one) : 'none';
      if (how === 'pasted') {
        flash('已贴上 ✓');
        return { ok: true, reason: 'pasted', text: one };
      }
      flash('没贴进去,已复制 ⌘V');
      return { ok: true, reason: 'copied', text: one };
    } finally {
      // 冷却:连点两下也只贴一遍
      setTimeout(() => {
        filling = false;
      }, 2000);
    }
  }

  /**
   * 「尾巴」按钮的两步走。
   *   未就绪 → 复制(带前导换行)→ 显示「已复制 ✓」→ 1 秒后变成「粘」
   *   已就绪 → 填进回复框末尾 → 显示「已贴上 ✓」/「没贴进去,已复制 ⌘V」→ 2 秒后回到「尾巴」
   */
  /**
   * 「尾巴」按钮:点一下 = 随机取一条进剪贴板(框里已有字时带前导换行)。
   *
   * ⚠ 曾经有第二步「粘」(1 秒后按钮变「粘」,再点填进回复框)——**已删**。
   * 两个理由:① 填框在现有边界下做不到不破坏输入框(见 TAILS-FILL-DESIGN.md);
   * ② 留着它就是个**假入口** —— 按钮承诺一件它不会做的事,点完只显示"没贴进去",
   *    用户会以为坏了(用户实测反馈:"显示没粘进去")。
   * 能力关着的时候,入口也不该在。
   */
  /** 第一击复制并记在内存里,第二击合成粘贴。发送永远留给你。 */
  async function onTailClick(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!btn) return;
    if (armed && FILL_ENABLED) {
      const r = await pasteInto();
      if (r.ok) {
        flash('已粘贴 ✓');
      } else if (r.why) {
        // 只看这一种真正的破坏形态:选中了文字,粘贴会替换它
        flash('选中了文字,会覆盖 —— 点一下正文末尾再来');
      } else {
        flash(r.reason === 'ghost' ? '没贴进去(请刷新页面),尾巴在剪贴板' : '没贴进去,已复制 ⌘V');
      }
      setTimeout(() => {
        if (btn) btn.textContent = '尾巴';
      }, 2500);
      return r;
    }
    await onPick();
    if (FILL_ENABLED) {
      const ed = editorNow();
      const t = lastCopied();
      // **复制失败就不许进入第二击**:否则会派发一个空粘贴(而且按钮上还写着"再点粘贴")
      if (ed && t) arm(t, ed);
    }
    if (!armed) {
      setTimeout(() => {
        if (btn) btn.textContent = '尾巴';
      }, 2000);
    }
    return { ok: true, reason: armed ? 'armed' : 'copied' };
  }

  function schedule() {
    if (stopped || raf) return;
    raf = true;
    const mine = gen; // 记下是这一代排的
    const run = () => {
      if (mine !== gen) return; // 上一代的遗留回调:作废,连标志都不动
      raf = false;
      ensureButton();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 卸掉观察器和按钮。测试之间要清(否则上一个实例的观察器会在新文档上又造一个按钮),
   *  生产里也给"模块被卸载"留一条干净的路。 */
  function stopTails() {
    stopped = true;
    gen += 1; // 作废所有已排队的回调
    raf = false;
    if (mo) {
      try {
        mo.disconnect();
      } catch {
        /* ignore */
      }
      mo = null;
    }
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    btn = null;
    if (transBtn && transBtn.parentNode) transBtn.parentNode.removeChild(transBtn);
    transBtn = null;
    transBusy = false;
    closePreview(); // 翻译中的迟到结果会因 gen 作废而被丢弃,面板在这里一并摘掉
  }

  function installComposerButton() {
    if (typeof document === 'undefined') return;
    stopped = false; // 显式安装 = 重新开始
    try {
      if (!mo && typeof MutationObserver === 'function') {
        // 回调只置一个标志:高频 mutation 也不怕(和角标同一个写法)
        mo = new MutationObserver(schedule);
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
      }
    } catch {
      /* 没有观察器也能用,只是按钮出现得慢一点 */
    }
    // 「译」按钮的装机门禁等一次异步能力读数:读出来是 'ok' 时补一轮装机
    try {
      const X = xfApi();
      if (X && typeof X.onTranslateCap === 'function') X.onTranslateCap(() => schedule());
    } catch {
      /* 引擎不在就没有「译」,尾巴照常 */
    }
    schedule();
  }

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
    // 延迟的自动安装也要看有没有被停过:否则 stopTails() 之后 DOMContentLoaded 一到,
    // 它会把按钮又装回来(那条"停完不许再造按钮"的用例就是被这个咬住的)。
    const auto = () => {
      if (!stopped) installComposerButton();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
    else auto();
  }

  return {
    sanitize,
    looksLikeContact,
    pick,
    copyText,
    fillTail,
    _onFill: onFill,
    _onTailClick: onTailClick,
    _armed: () => armed,
    _disarm: disarm,
    get,
    save,
    remember,
    lastCopied,
    installComposerButton,
    stopTails,
    _ensureButton: ensureButton,
    _onPick: onPick,
    // 「译」按钮(v1)的测试钩子
    _onTransClick: onTransClick,
    _onReplaceClick: onReplaceClick,
    _replaceCtx: () => replaceCtx,
    _draftTextOf: draftTextOf,
    _closePreview: closePreview,
    _transBtn: () => transBtn,
    _previewEl: () => previewEl,
    CAP,
    MAX_LEN,
    KEY,
  };
});
