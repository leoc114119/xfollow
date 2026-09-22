// 后台标签页里的执行器:替你在 X 自己的界面上点那一下。
//
// ══ 为什么要开一个后台标签页 ══════════════════════════════════
// 关注这个动作必须由 **X 自己的页面**发出去 —— 那样它带着自己的签名、自己的节奏,
// 永远不会踩 transaction-id 和限流那一套检测。所以我们必须真的把那个人的主页
// 加载出来。iframe 不行(X 的页面禁止被嵌框),所以用 `active: false` 的标签页:
// 它在后台加载、在后台点击,你的前台标签页和侧边栏都不受影响。
//
// ══ 这个文件只做四件事 ════════════════════════════════════════
//   1. 确认"我就是后台那个执行器"(靠后台告诉我 tabId,不靠猜)
//   2. 等 X 把主页渲染出来,并且按钮处于"还没关注"的状态
//   3. 点它 —— 只点一次
//   4. 用**页面自己发出的请求结果**确认成没成,而不是看按钮变了没有
//
// ══ 边界(和整个项目一致)══════════════════════════════════════
//   · 不发任何自己的请求。点击由 X 的页面处理,我们只是按了一下。
//   · 只点 testid 带 id 的那个按钮:方向由 id 决定,不看文字,不可能点反。
//   · 一次只做一个。失败不重试 —— 失败说明假设有问题,该停下来看原因。
//   · 看到任何限流信号立刻停,并把原因交回去。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.XF = root.XF || {};
    Object.assign(root.XF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const JOB_KEY = 'xf:job';

  // 本文档的出生标记。重新加载会换一个新文档,于是换一个新 nonce ——
  // 后台靠它证明"我读的是重新加载之后的那一页",而不是原来那个还活着的旧文档。
  //
  // 为什么必须有它:复查用的是"重新加载他的主页再读一次状态"。
  // 如果 reload 没真的换文档,我们就会对着**旧 DOM** 读出一个过期状态,
  // 然后拿它当结论 —— 真机报的"明明成功了却说没成功"就是这么来的。
  const DOC_NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // 命名空间在加载时抓一次 + 兜底。
  // 为什么不每次读 globalThis.XF:在 DOM/定时器回调里它不保证还读得到
  // (sidebar.js 踩过同样的坑,表现是"回调里读到 undefined,点一下没反应")。
  let NS = globalThis.XF || null;
  function ns() {
    if (!NS) NS = globalThis.XF || (typeof window !== 'undefined' && window.XF) || null;
    return NS || {};
  }

  // 按钮出现 / 点击生效 各自等多久(毫秒)
  const WAIT_BUTTON = 15000;
  const WAIT_RESULT = 12000;
  const POLL = 150;
  // 客户端切页等多久。它是本地的,慢了就说明这条快路没走通,早点退回整页导航。
  const GOTO_WAIT = 4000;
  // 复查读状态前等按钮渲染的时限。测试会把它调小,免得一个用例等十几秒。
  let CHECK_WAIT = 12000;

  function chromeOk() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function getJob() {
    return new Promise((resolve) => {
      if (!chromeOk() || !chrome.storage || !chrome.storage.local) return resolve(null);
      chrome.storage.local.get([JOB_KEY], (r) => resolve((r && r[JOB_KEY]) || null));
    });
  }

  // 当前这个页面在处理哪一条任务。**所有写入都拿它比对** ——
  // 少了它就会出现:A 任务收尾时把状态写进已经被 B 任务覆盖的记录里
  // (审查复现过:bbb 那条记录被写上了 A 的 want),或者一个已经 failed 的任务
  // 被旧快照改回 done。任务身份用一个一次性 jobId 收口,而不是到处打补丁。
  let activeJobId = null;

  function setJob(patch) {
    return new Promise((resolve) => {
      if (!chromeOk() || !chrome.storage || !chrome.storage.local) return resolve();
      chrome.storage.local.get([JOB_KEY], (r) => {
        const cur = (r && r[JOB_KEY]) || {};
        // 存储里那条已经不是我在处理的了 → 一个字都不写
        if (cur.jobId && activeJobId && cur.jobId !== activeJobId) return resolve();
        const next = Object.assign({}, cur, patch);
        if (activeJobId && !next.jobId) next.jobId = activeJobId;
        chrome.storage.local.set({ [JOB_KEY]: next }, () => resolve());
      });
    });
  }

  function askBackground(msg) {
    return new Promise((resolve) => {
      if (!chromeOk() || !chrome.runtime.sendMessage) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** 页面上的路径是不是这个人的主页 */
  function handleOnPage() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/?$/);
    if (!m || m[1].toLowerCase() === 'i') return null;
    return m[1];
  }

  /** 等一个条件成立,超时返回 null */
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, POLL));
    }
    return null;
  }

  /**
   * 只认 testid 的状态探针。
   *
   * **快路的自证和动手前的预检必须用这个**,不能用下面那个带文字兜底的版本 ——
   * 文字兜底读的是页面上那个 `userActions` 容器,而**路由没反应时它属于上一个人**。
   * 真机复现过:目标 testid 全缺、DOM 还停在上一个人的页面,`directionOf` 却从上一个人的
   * 按钮文字里读出一个值,于是快路的两道自证双双通过 —— 明明没切过去却报成功。
   * (点击层一直是 testid-only,所以方向安全没破;破的是"切页成功了没有"这个判断。)
   */
  function directionStrict(id) {
    if (document.querySelector(`[data-testid="${id}-unfollow"]`)) return 'following';
    if (document.querySelector(`[data-testid="${id}-following"]`)) return 'following';
    if (document.querySelector(`[data-testid="${id}-follow"]`)) return 'follow';
    return null;
  }

  /**
   * 这个人**现在**是什么状态(带文字兜底,只用于**读**,不用于自证或动手)。
   *
   * 只用带 id 的 testid:${id}-follow(还没关注)/ ${id}-unfollow、${id}-following(已关注)。
   * 不按按钮文字判断 —— 文案会变、会本地化,而且个人主页上还有别人的推荐位。
   */
  function directionOf(id) {
    if (document.querySelector(`[data-testid="${id}-unfollow"]`)) return 'following';
    if (document.querySelector(`[data-testid="${id}-following"]`)) return 'following';
    if (document.querySelector(`[data-testid="${id}-follow"]`)) return 'follow';
    // testid 读不到时,退而在主页头部那一组按钮里看文字。
    // **只用来看状态,绝不用来决定点哪个** —— 点哪一个必须靠 id 精确匹配。
    // 注意 X 的中文词:「回关」是"他关注你、你还没关注他",也就是**未关注**状态。
    const box = document.querySelector('[data-testid="userActions"]');
    if (box) {
      for (const b of box.querySelectorAll('[role="button"], button')) {
        const t = (b.textContent || '').trim();
        if (!t) continue;
        if (/^(正在关注|已关注|Following|Unfollow)$/i.test(t)) return 'following';
        if (/^(关注|回关|Follow|Follow back)$/i.test(t)) return 'follow';
      }
    }
    return null;
  }

  /**
   * 找到该点的那一个按钮。
   *
   * **方向必须精确匹配,而且只认带 id 的 testid。** 关注和取关按钮在同一个位置、
   * 尺寸也差不多,点错一下就是把事情做反了 —— 而"做反"在这个工具里是
   * 取关一个你本来想关注的人。所以宁可不点,也不猜。
   *
   * @param want 'follow' 要关注 | 'unfollow' 要取关
   */
  function findButton(id, want) {
    const followBtn = document.querySelector(`[data-testid="${id}-follow"]`);
    const unBtn =
      document.querySelector(`[data-testid="${id}-unfollow"]`) ||
      document.querySelector(`[data-testid="${id}-following"]`);

    if (want === 'unfollow') {
      // 要取关,就必须确认"现在是关注着的",否则那一下点到的会是 Follow
      return unBtn ? { btn: unBtn, dir: 'following' } : null;
    }
    return followBtn ? { btn: followBtn, dir: 'follow' } : null;
  }

  /** 这次写请求走的端点(从被动采样里读)—— 只用于显示,不做任何判断 */
  function endpointNow() {
    try {
      const r = ns().lastServerAction ? ns().lastServerAction() : null;
      return r && r.endpoint ? r.endpoint : null;
    } catch {
      return null;
    }
  }

  function esc(sn) {
    return String(sn || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 从确认按钮往上找到那个"框",只认**结构性**标识。
   *
   * 为什么要往上找:按钮本身有 testid,但它属于哪个框要靠祖先判断 ——
   * 页面别处也可能有同样的按钮。找不到认识的框就返回 null,调用方据此**放弃点击**。
   */
  function sheetRoot(btn) {
    // 从**父节点**开始往上找 —— 从按钮自己开始的话,它自己的 testid
    // (confirmationSheetConfirm)就含 "confirmationSheet",会把自己当成那个框,
    // 于是拿到的 textContent 只有按钮文字、拿不到标题里的 @handle,核对必然失败。
    let el = btn.parentElement;
    for (let i = 0; i < 8 && el; i++) {
      const tid = (el.getAttribute && el.getAttribute('data-testid')) || '';
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      const modal = (el.getAttribute && el.getAttribute('aria-modal')) || '';
      if (role === 'dialog' || modal === 'true') return el;
      if (/confirmationSheet|SheetDialog/i.test(tid)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 取关的二次确认框。
   *
   * 真机确认过:X 个人主页上点「正在关注」**不会直接取关**,而是弹出确认框
   * (标题 "取消关注 @某人?",一个实心的「取消关注」和一个描边的「取消」)。
   * 我们原来只点一下,所以永远停在"已关注"。
   *
   * 安全线没有破:
   *   · 点哪个 —— 靠**结构性 testid**(confirmationSheetConfirm)和框的祖先结构决定
   *   · 文字 —— 只用来**核对**这个框说的是不是我们要处理的那个人,绝不用来决定点哪个按钮
   * 核对不上就不点,并明确报告"无法安全识别"。
   */
  function findConfirmButton(sn) {
    const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (!btn) return null;
    const rootEl = sheetRoot(btn);
    if (!rootEl) return { ok: false, why: '找到了确认按钮,但它不属于一个可识别的确认层' };
    // 框里必须提到目标那个 handle —— 这条是"别把别人的确认框点了"的保险
    const text = rootEl.textContent || '';
    if (!sn || !new RegExp('@' + esc(sn) + '\\b', 'i').test(text)) {
      return { ok: false, why: '确认框里没有提到 @' + String(sn) + ',不敢点' };
    }
    return { ok: true, btn };
  }

  /** 真的去点。只点 findButton 找到的那一个。 */
  function clickAction(id, want) {
    const found = findButton(id, want);
    if (!found) {
      const now = directionOf(id);
      if (want === 'follow' && now === 'following') return { ok: false, reason: '按 X 的界面,你已经关注他了' };
      if (want === 'unfollow' && now === 'follow') return { ok: false, reason: '按 X 的界面,你并没有关注他' };
      return { ok: false, reason: '按钮不见了(可能在等渲染的时候就变了)' };
    }
    try {
      found.btn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: '点击抛错:' + (e && e.message) };
    }
  }

  /**
   * 确认结果。
   *
   * 主要看**页面自己发出的 friendships/create 响应** —— 那是请求的真实结果,
   * 比按钮变了没有硬得多(乐观 UI 会先翻转、失败再回滚,光看按钮会被骗)。
   * 按钮状态只作为辅助信号。
   */
  /**
   * 点完之后先做一次**快速**确认。
   *
   * 只等很短:要么等到页面自己发出的请求结果(最硬的证据),要么看到按钮翻转。
   * 两个都没等到就**不要下结论** —— 真机就是这样误报的:关注明明成功了,
   * 而我们既没抓到响应、按钮又没读到,于是报"大概是没成功"。
   *
   * 拿不准的时候把状态标成 `clicked`,交给后台**重新加载页面再读一次**。
   * 那才是真正的查询:重新加载之后页面显示的是服务器上的真实状态。
   */
  async function quickConfirm(id, want, clickedAt) {
    const X = ns();
    const expectFollowing = want === 'follow';

    // ① 最硬的证据:页面自己发出的 friendships/create|destroy 的结果(起一个 promise,先不 await)
    const byServer = waitFor(() => {
      try {
        const st = X.__workerState;
        if (!st) return null;
        const r = st.relations && st.relations[id];
        const s = r && r.obs && r.obs.iFollow && r.obs.iFollow.server;
        if (s && s.v === expectFollowing && s.at >= clickedAt) return 'server';
        return null;
      } catch {
        return null;
      }
    }, WAIT_RESULT);

    // ② 同时盯着按钮翻转 —— **两条并行等,不是串行**。
    // 串行的话"响应没被采到、但按钮确实翻了"这种情况要白等满 12 秒(审查指出的)。
    // 并行之后:谁先到先算,但**强证据优先** ——
    // 如果先看到按钮翻转,再给它一个短窗口(1.5 秒)等响应,响应到了就用强的那个。
    // 这样既省掉大部分等待,又不会让"乐观 UI 翻转"这种弱证据抢先定论。
    const wantDom = expectFollowing ? 'following' : 'follow';
    const domP = waitFor(() => (directionOf(id) === wantDom ? wantDom : null), 2500);

    const serverFirst = await Promise.race([
      byServer, // 已经是 promise
      domP.then((v) => (v ? null : new Promise(() => {}))), // 没翻转就一直挂着,不抢先
    ]);
    if (serverFirst) return { ok: true, via: '页面自己的请求结果' };

    const dom = await domP;
    if (dom) {
      // 弱证据先到:给它 1.5 秒,看强证据会不会紧跟着来
      const grace = await Promise.race([byServer, new Promise((r) => setTimeout(() => r(null), 1500))]);
      return { ok: true, via: grace ? '页面自己的请求结果' : '按钮已翻转(没看到请求结果)' };
    }

    // ③ 两项都没拿到 → **不下结论**,交给后台重新加载页面去查
    return { ok: false, unknown: true, via: null, reason: '页面上看不到结果,需要重新加载页面确认' };
  }

  /**
   * 处理二次确认框。
   *
   * 返回:
   *   null                 没有框出现 —— 这个动作不需要二次确认,继续走
   *   { clicked: true }    框出现了、核对过是本目标、已经点了确认
   *   { blocked: true, why } 框出现了但**无法安全识别** —— 不点,并且说清为什么
   *
   * 为什么"识别不了就不点":一个能被误点的确认框,比一个做不到的功能危险得多 ——
   * 它可能正在确认别的破坏性操作。宁可这次不做。
   */
  async function handleConfirmSheet(sn, want) {
    // **等多久取决于方向**。这一步原来一律等 4 秒 —— 而关注根本不会弹框,
    // 于是每关注一个人就白等 4 秒。取关确实会弹(真机确认过),但那个框是本地渲染的,
    // 一两百毫秒就出来,也不该等满 4 秒。
    // 关注仍留一点窗口(600ms):万一 X 哪天给关注也加了确认,我们能接住。
    const budget = want === 'unfollow' ? 2000 : 600;
    const btn = await waitFor(() => {
      const r = findConfirmButton(sn);
      return r && (r.ok || r.why) ? r : null;
    }, budget);

    if (!btn) return null; // 没出现确认框
    if (!btn.ok) return { blocked: true, why: '取关确认框无法安全识别:' + btn.why + ' —— 没有点它' };

    try {
      btn.btn.click();
      return { clicked: true };
    } catch (e) {
      return { blocked: true, why: '点确认框时出错:' + (e && e.message) };
    }
  }

  /**
   * 盯着账本。
   *
   * 原来是**每秒把整个账本读一遍** —— 页面自己那个请求的结果写进账本之后,
   * 我们最多要晚 1 秒才发现,而这段时间就干等着。
   * 现在改成听存储变更:账本一写我们立刻就知道,不用轮询,也没有那 1 秒延迟。
   */
  let stateWatched = false;
  let inFlight = false;
  let timings = {};

  /** 任务是不是已经有结论了 */
  function isSettledJob(job) {
    return !!job && (job.status === 'done' || job.status === 'failed');
  }

  function watchState() {
    if (stateWatched) return;
    stateWatched = true;
    const X = ns();
    const initial = async () => {
      try {
        X.__workerState = await X.loadState();
      } catch {
        /* ignore */
      }
    };
    initial();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes['xf:relations']) return;
        const rel = changes['xf:relations'].newValue;
        if (!rel) return;
        // 只补关系表就够了 —— 确认结果只看它
        X.__workerState = Object.assign({}, X.__workerState, { relations: rel });
      });
    } catch {
      /* 听不了就退回初始那一次读 */
    }
  }

  async function run(pushed) {
    // 两条入口:后台**推**过来的任务(正常路径),或者页面自己从存储里读(兜底)。
    // 推的那条不依赖 whoami,所以少一次往返、也少一个可能断掉的环节。
    let job = pushed || null;
    if (job && (job.status === 'done' || job.status === 'failed')) return; // 已经结束的就不碰了
    if (!job) {
      job = await getJob();
      if (!job || !job.id) return; // 没有任务:绝大多数页面的正常情况,不写状态
      if (job.status === 'done' || job.status === 'failed') return; // 已经处理过了

      // 页面自己读的时候才需要确认"我是那个执行器"
      const who = await askBackground({ type: 'xf:whoami' });
      if (!who || !who.isWorker) return; // 不是执行器:正常页面,不写状态
    }
    if (!job.id || !job.sn) return;
    if (inFlight) return; // 同一个页面里同一个任务只处理一次
    inFlight = true;
    activeJobId = job.jobId || null;

    // 到这里为止都还是"我不是干这个的",所以不写状态。
    // 再往下就**必须留下痕迹了** —— 静默返回会让界面永远停在"正在后台打开…",
    // 而那是这个项目里最难查的一种状态(用户看到的是"卡住",没有原因)。
    await setJob({ status: 'booting', bootedAt: Date.now() });

    // 这一页是不是目标那个人的主页
    const pageHandle = handleOnPage();
    if (!pageHandle) {
      await setJob({ status: 'failed', reason: '这个标签页停在了不是个人主页的地方:' + location.pathname, finishedAt: Date.now() });
      return finish();
    }
    if (job.sn && pageHandle.toLowerCase() !== String(job.sn).toLowerCase()) {
      await setJob({
        status: 'failed',
        reason: `打开的是 @${pageHandle},但目标是 @${job.sn} —— 没有动手`,
        finishedAt: Date.now(),
      });
      return finish();
    }

    const want = job.kind === 'unfollow' ? 'unfollow' : 'follow';
    const label = want === 'follow' ? '关注' : '取关';

    // 分段耗时。**不报出来就永远不知道慢在哪一步** —— 前面几轮优化全是靠猜的。
    // 这些数字会跟着任务状态一起落在存储里,界面在成功的提示里带出来。
    timings = { startedAt: Date.now() };

    await setJob({ status: 'running', startedAt: Date.now() });
    watchState();

    // 等 X 把主页头部渲染出来
    // 预检也要 testid-only:文字兜底可能读的是**上一个人**的按钮,
    // 于是我们会以为"按钮在",接着 clickAction 找不到目标 testid → 报一个误导的原因。
    const dir = await waitFor(() => directionStrict(job.id), WAIT_BUTTON);
    if (!dir) {
      await setJob({ status: 'failed', reason: `等了 15 秒也没看到这个人的按钮(主页可能没加载出来),所以没有${label}`, finishedAt: Date.now() });
      return finish();
    }
    // 状态和目标必须一致。不一致就**不点** —— 点下去就是反着做
    if (want === 'follow' && dir === 'following') {
      await setJob({ status: 'failed', reason: '按 X 的界面,你已经关注他了 —— 所以没有点', finishedAt: Date.now() });
      return finish();
    }
    if (want === 'unfollow' && dir === 'follow') {
      await setJob({ status: 'failed', reason: '按 X 的界面,你并没有关注他 —— 所以没有取关', finishedAt: Date.now() });
      return finish();
    }

    // 点之前先看一眼有没有限流浮层
    const limit = ns().scanDomForLimit ? ns().scanDomForLimit() : null;
    if (limit) {
      await setJob({ status: 'failed', reason: '页面上有 X 的限制提示:' + limit, finishedAt: Date.now() });
      return finish();
    }

    const clickedAt = Date.now();
    timings.ready = clickedAt - (timings.startedAt || clickedAt);
    const clicked = clickAction(job.id, want);
    if (!clicked.ok) {
      await setJob({ status: 'failed', reason: clicked.reason, finishedAt: Date.now() });
      return finish();
    }

    // 点完之后可能弹出一个二次确认框(X 的取关就是这样)。
    // 等一小会儿看有没有;**有就只点它一次**,没有就照旧往下走。
    const sheetAt = Date.now();
    const confirmed = await handleConfirmSheet(job.sn, want);
    timings.sheet = Date.now() - sheetAt;
    if (confirmed && confirmed.blocked) {
      await setJob({ status: 'failed', reason: confirmed.why, finishedAt: Date.now() });
      return finish();
    }

    timings.clickToResult = Date.now() - clickedAt;
    const res = await quickConfirm(job.id, want, clickedAt);
    if (res.ok) {
      // 页面自己那个请求的响应由 bridge 顺手记了;这里是为"只看到按钮翻转"那条路兜底 ——
      // 无论从哪条路确认的,账本都必须反映关系已经变了,否则名单不会更新。
      await remember(job.id, job.sn, want === 'follow', 'page');
      await setJob({
        status: 'done',
        via: res.via,
        finishedAt: Date.now(),
        timings,
        endpoint: endpointNow(), // 这次写请求走的端点(发现 X 改接口用)
      });
    } else if (res.unknown) {
      // 拿不准时把端点一起带出去 —— 如果端点变了,那正是"收不到结果"的原因
      await setJob({ endpoint: endpointNow() });
      // 拿不准:标成 clicked,等后台重新加载页面来查真实状态
      await setJob({ status: 'clicked', clickedAt, want, unknownReason: res.reason });
    } else {
      await setJob({ status: 'failed', reason: res.reason, finishedAt: Date.now() });
    }
    return finish();
  }

  /**
   * 把"确认过了"这件事写回账本。
   *
   * 少了这一步就会出现:界面说 ✓ 已关注,但那个人还留在名单上 ——
   * 因为账本只知道"我们点了",不知道"关系已经变了"。
   * 名单是按关系事实筛的,所以确认成功之后**必须把事实写进去**。
   */
  async function remember(id, sn, following, source) {
    const X = ns();
    if (!X.applyServerAction) return;
    try {
      await X.applyServerAction(id, sn, following, Date.now(), source);
    } catch {
      /* 写账本失败不影响这次动作的结论 */
    }
  }

  /**
   * 收尾。
   *
   * **不在这里关自己的标签页。** 关标签页是后台的事:它盯着 xf:job 的状态,
   * 看到有结论了才关。让页面自己请求关闭会制造一个死结 ——
   * 关了之后回执/后续消息都发不出去,而"发不出去"会被误读成"没送到"。
   */
  function finish() {
    inFlight = false;
    // 存储监听不用拆:它只把结果搬进内存,没有定时器要停。
    // 拆掉反而会让"复查"那条路读不到刚写进去的结果。
  }

  // 只在页面就绪后跑一次。SPA 换页不会重跑,所以也只处理"进来时就有任务"这一种情况 ——
  // 后台每次都是**新开或导航**一个标签页,那必然是一次真实的页面加载。
  function boot() {
    if (!chromeOk()) return;
    if (root.XF && root.XF.__workerBooted) return;
    if (root.XF) root.XF.__workerBooted = true;
    run().catch(async (e) => {
      try {
        await setJob({ status: 'failed', reason: '执行器出错:' + (e && e.message), finishedAt: Date.now() });
      } catch {
        /* ignore */
      }
    });
  }

  // 后台推任务进来。这是常规路径 —— 不再依赖页面主动去问"我是执行器吗"。
  // 之所以要有个 onMessage 监听器,还有一个副作用是好的:后台 ping 得到应答,
  // 才能确认"这个标签页里的脚本是活的",否则它只能干等然后报一句卡住。
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || typeof msg !== 'object') return undefined;
      // 异步处理器要自己兜住异常 —— 抛出去会变成 unhandled rejection,
      // 而调用方那边只会看到"没有回应",又是一次没有信息的失败。
      const safeReply = (fn) => {
        Promise.resolve()
          .then(fn)
          .catch((e) => {
            try {
              reply({ ok: false, reason: (e && e.message) || '处理消息时出错' });
            } catch {
              /* ignore */
            }
          });
      };
      if (msg.type === 'xf:ping') {
        reply({ ready: true, nonce: DOC_NONCE, href: location.href });
        return true;
      }

      // 客户端切页(快路)。
      //
      // 为什么不干脆整页导航:整页加载要重新拉包、重新解析 X 那一大坨 JS,几秒钟起步;
      // 而 X 本身就是 SPA,它自己换页就是 pushState + 路由响应 —— 那是几百毫秒。
      //
      // **但快路必须能自证**。切页这件事有两种坏法:URL 变了但 X 没反应(还显示上一个人),
      // 或者路由反应了但关系状态还没加载完。所以这里卡两道:
      //   ① 路径必须变成目标,而且**目标的那个按钮出现**(按钮带 id,出现即证明是他的主页)
      //   ② 那个方向必须**连续两次读到一样** —— 过滤掉"还没加载完"的中间态
      // 任何一条不满足就返回失败,由后台退回整页导航。**不做任何猜测。**
      if (msg.type === 'xf:goto') {
        safeReply(async () => {
          const want = '/' + String(msg.sn || '');
          if (!msg.sn || !msg.id) {
            reply({ ok: false, why: '缺目标' });
            return;
          }
          // 页面正在处理上一个任务时**绝不允许被导航走** ——
          // 那个任务的确认逻辑正读着这一页的 DOM,把页面换掉会让它读到新目标的 DOM。
          // 让后台退回整页导航(新文档),这是安全的。
          if (inFlight) {
            reply({ ok: false, why: '这个页面正在处理上一个任务,不能拿它当快路' });
            return;
          }
          if (location.pathname === want && directionStrict(msg.id)) {
            reply({ ok: true, how: 'already' });
            return;
          }
          try {
            history.pushState({}, '', want);
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          } catch (e) {
            reply({ ok: false, why: '推不动历史记录:' + (e && e.message) });
            return;
          }
          // ① 路径 + 目标的按钮
          const arrived = await waitFor(
            () => (location.pathname === want && directionStrict(msg.id) ? directionStrict(msg.id) : null),
            GOTO_WAIT
          );
          if (!arrived) {
            reply({ ok: false, why: '客户端切页之后没有渲染出这个人的主页' });
            return;
          }
          // ② 方向稳定(连续两次一样),避免在关系状态还没加载完时就动手
          await new Promise((r) => setTimeout(r, 250));
          const again = location.pathname === want ? directionStrict(msg.id) : null;
          if (!again || again !== arrived) {
            reply({ ok: false, why: '切页之后状态还在变,不敢动手' });
            return;
          }
          reply({ ok: true, how: 'spa' });
        });
        return true;
      }
      // 后台重新加载页面之后的复查:读页面上现在是什么状态,给任务定论。
      // 这是"做一次查询"的落点 —— 重新加载之后,页面显示的就是服务器上的真实关系。
      if (msg.type === 'xf:check-job') {
        const job = msg.job || null;
        if (!job || !job.id || isSettledJob(job)) {
          reply({ ok: true, skipped: true });
          return true;
        }
        // 复查也认这条任务的身份
        activeJobId = job.jobId || null;
        // ⚠ **还要重读存储里当前那条。** 推过来的只是当初派车时的一份快照 ——
        // 在它之后,这条任务可能已经被别的路径收尾了(比如用户又点了一次、
        // 或者界面看门狗把它判成失败)。审查复现过:一条已经 failed 的任务
        // 被这份旧快照改回 done。只信快照就等于让一个过期的决定覆盖当前的结论。
        safeReply(async () => {
        const cur = await getJob();
        if (cur && (isSettledJob(cur) || (cur.jobId && job.jobId && cur.jobId !== job.jobId))) {
          reply({ ok: true, skipped: true, why: '这条任务已经有结论了,复查不再改它' });
          return;
        }
        // 复查这条路的耗时也要报 —— 它是**最慢的一条**(要重新加载整页),
        // 不报出来就不知道"点完到结论"到底是几秒。
        const clickToResult = Date.now() - (job.clickedAt || Date.now());
        const wantFollowing = job.want === 'unfollow' ? false : true;
        // **等按钮渲染出来**再读。刚重新加载的页面不可能立刻就绪,
        // 立刻读只会读到 null,然后把"读不到"当成"没成功"。
        const st = await waitFor(() => directionOf(job.id), CHECK_WAIT);
        if (st === null) {
          setJob({
            status: 'failed',
            reason: '重新加载了他的主页,但读不到关注按钮 —— 这个判断不了,请你在页面上看一眼',
            finishedAt: Date.now(),
            timings: { clickToResult },
            endpoint: endpointNow(),
          });
          reply({ ok: true, settled: 'failed' });
          return true;
        }
        const gotFollowing = st === 'following';
        if (gotFollowing === wantFollowing) {
          // 关系确实变了 —— 写回账本,那一行才会从名单里消失
          await remember(job.id, job.sn, wantFollowing, 'page');
          setJob({
            status: 'done',
            via: '重新加载页面后确认',
            finishedAt: Date.now(),
            timings: { clickToResult },
            endpoint: endpointNow(),
          });
          reply({ ok: true, settled: 'done' });
        } else {
          setJob({
            status: 'failed',
            reason: wantFollowing
              ? '重新加载他的主页后,仍然显示"未关注" —— 这一次没成功'
              : '重新加载他的主页后,仍然显示"已关注" —— 这一次没取关成功',
            finishedAt: Date.now(),
            timings,
            endpoint: endpointNow(),
          });
          reply({ ok: true, settled: 'failed' });
        }
        });
        return true;
      }

      if (msg.type === 'xf:do-job') {
        const pushed = msg.job || null;
        // **立刻回执**,然后才开始干活。
        //
        // 为什么不能等做完再回:做完之后这个标签页就会被关掉,而回执发不出去 ——
        // 后台那边会报"对方没有回应",可实际上任务早就送达并做成了。
        // 真机就是这么骗了我一轮:报失败,而关注是成功的。
        //
        // 所以这里的回执只表示"**送达**",不表示"做成了"。
        // 做没做成由 xf:job 的状态告诉界面(侧边栏本来就在盯着它)。
        reply({ ok: true, accepted: true });
        run(pushed).catch((e) => {
          // inFlight 必须在这里也放掉。少了这一步,一次抛错就把这个页面**永久**弄哑 ——
          // 后面每个任务都会在 `if (inFlight) return` 那里静默返回,而任务留在 running 上没人收。
          inFlight = false;
          setJob({ status: 'failed', reason: '执行器出错:' + (e && e.message), finishedAt: Date.now() });
        });
        return true;
      }
      return undefined;
    });
  }

  // ⚠ 这里**故意没有**"页面自己读存储再跑一遍"的兜底。
  //
  // 加过,是错的:那会和后台推送变成两条路同时跑同一个任务 ——
  // 第一条点成功写了 ✓,第二条看到按钮已经变成"已关注"就写了 ✗,
  // 把成功覆盖掉。真机表现就是"报失败,但实际关注成功了"。
  // 一个任务只能由**一个**入口处理:后台推。
  // (后台推之前会 ping 确认脚本活着,推不动就直接报"脚本没响应" —— 那条路是可诊断的。)

  return {
    JOB_KEY,
    DOC_NONCE,
    directionOf,
    findButton,
    clickAction,
    isSettledJob,
    _run: run,
    // 供测试直接验证二次确认那段逻辑
    _findConfirmButton: findConfirmButton,
    _handleConfirmSheet: handleConfirmSheet,
    _setCheckWait: (ms) => { CHECK_WAIT = ms; },
    _setInFlight: (v) => { inFlight = !!v; },
    _setActiveJob: (id) => {
      activeJobId = id || null;
    },
    _setJob: (patch) => setJob(patch),
    _directionStrict: (id) => directionStrict(id),
  };
});
