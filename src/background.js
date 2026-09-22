// Service worker:开合侧边栏 + 调度后台执行器。
//
// ══ 两件事 ════════════════════════════════════════════════════
//   1. 点扩展图标 → 找到(或打开)x.com 标签页,开合侧边栏
//   2. 「替你关注」→ 在**后台标签页**(active:false)里打开那个人的主页,
//      由 worker.js 点 X 自己的关注按钮,做完把这个标签页关掉
//
// ══ 为什么调度必须放在 service worker 里 ═══════════════════════
//   · 侧边栏所在的页面随时可能被导航走或被关掉,调度不能住在那里
//   · MV3 的 SW 是全浏览器单实例 —— 内存里的一个变量就是真正的互斥量,
//     所以"同一时间只允许一个后台任务"这件事不需要靠存储去凑
//
// ══ 三道闸,都是为了不把这个工具变成"批量关注机器" ═══════════════
//   · 一次只跑一个:上一个没结束,新的点击直接拒绝,不排队
//   · 两个任务之间至少隔 MIN_GAP:人的节奏,不是脚本的节奏
//   · 任何一次失败(限流、按钮找不到、结果不明)都**不重试** ——
//     失败说明假设有问题,该停下来看原因

const X_URLS = ['https://x.com/*', 'https://twitter.com/*'];
const JOB_KEY = 'xf:job';
const MIN_GAP_MS = 6000;
const JOB_TIMEOUT_MS = 45000;
// 执行器标签页做完之后留多久(毫秒)。留着是为了复用 —— 下一次少一次冷启动。
// 也不能留太久:一个后台 x.com 页面自己是会轮询的,占内存也占 CPU。
const IDLE_KEEP_MS = 20000;
const IDLE_KEY = 'xf:workerIdleUntil';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把任务**推**给那个标签页。
 *
 * 注意这里是**在一个未回复的 sendResponse 里等**的:这条通道开着,service worker
 * 就不会被回收 —— 而"派车完成到页面加载完"之间恰好是它最容易被杀的时候。
 * 顺带把那个坑堵上了。
 */
async function handOff(tabId, job, opts) {
  lastDispatchAt = Date.now();
  await storeSet(IDLE_KEY, 0); // 有人用了,取消"闲置"

  const url = 'https://x.com/' + job.sn;
  const oldNonce = (opts && opts.oldNonce) || null;

  // 导航之后要等两件事:地址变成目标、而且**里面的脚本是新的那个文档**。
  // 它们合成**一个**轮询循环 —— 原来是"等地址"再"等脚本"两段串行,慢且多余。
  //
  // 注意**不能**简单地把两件事并行:并行会 ping 到**旧文档**(它答得飞快),
  // 这正是复查那条路上踩过的坑。所以判据还是 nonce:地址对 **且** nonce 变了。
  // (新建标签页没有旧文档,nonce 传 null,退化成"等脚本应答"。)
  const ready = oldNonce
    ? await waitForNewDocument(tabId, url, oldNonce, 20000).then((x) => !!x)
    : await Promise.all([waitForTabUrl(tabId, url, 20000), waitForWorker(tabId, 15000)]).then(
        // 新建标签页没有"旧文档"可ping错,所以这两段**并行**是安全的(审查的建议)
        ([urlOk, workerOk]) => urlOk && workerOk
      );
  if (!ready) {
    // 说清"页面到底开了没有" —— 这两件事的修法完全不同
    let where = '';
    try {
      const t = await new Promise((r) => {
        chrome.tabs.get(tabId, (x) => {
          void chrome.runtime.lastError;
          r(x || null);
        });
      });
      where = t ? ` 标签页当前地址:${t.url || '(读不到)'} 状态:${t.status || '?'}` : ' 标签页已经不在了。';
    } catch {
      /* ignore */
    }
    await failJob(
      '后台标签页里的脚本没有响应(等了 15 秒)。' +
        (where || '') +
        ' 这说明页面可能开了,但我们的内容脚本没在里面跑 —— ' +
        '重载扩展之后刷新一次 x.com 再试(重载扩展不会更新已经打开的页面)。',
      jobId
    );
    return { ok: true, tabId, handedOff: false };
  }
  const r = await sendToTab(tabId, { type: 'xf:do-job', job });
  if (!r || !r.ok) {
    await failJob('任务没能交给后台标签页:' + ((r && r.reason) || '对方没有回应'), jobId);
    return { ok: true, tabId, handedOff: false };
  }
  return { ok: true, tabId, handedOff: true };
}

function send(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        resolve(err ? null : resp || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function readJob() {
  return new Promise((resolve) => {
    chrome.storage.local.get([JOB_KEY], (r) => resolve((r && r[JOB_KEY]) || null));
  });
}

/**
 * 写一条失败状态。**但如果这个任务已经结束了,什么都不做。**
 *
 * 这条守卫是防"报失败但其实成功了":页面那边可能已经把任务标成 done,
 * 而派车或推送的某一步超时后又来写一条 failed —— 后者会把真实结果覆盖掉,
 * 用户看到的就是"失败",而实际上关注已经成功了。真机上就是这么骗了我好几轮。
 */
/** 这个任务是不是已经有结论了。有结论就不许再改 —— 见 failJob 的说明。 */
function isSettled(job) {
  return !!job && (job.status === 'done' || job.status === 'failed');
}

async function failJob(reason, jobId) {
  const cur = await readJob();
  if (isSettled(cur)) return false;
  // 存储里那条已经不是当初派出去的那条了(用户又点了一次)→ 不许拿旧任务的失败去覆盖
  if (jobId && cur && cur.jobId && cur.jobId !== jobId) return false;
  await writeJob({ status: 'failed', reason, finishedAt: Date.now() });
  return true;
}

function writeJob(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.get([JOB_KEY], (r) => {
      const cur = (r && r[JOB_KEY]) || {};
      chrome.storage.local.set({ [JOB_KEY]: Object.assign({}, cur, patch) }, () => resolve());
    });
  });
}

// ── 后台执行器标签页 ─────────────────────────────────────────
//
// ⚠ 这个 id **不能只存在内存里**。踩过一次:MV3 的 service worker 空闲就会被回收,
// 而"派车完成"到"那个标签页加载完"之间 SW 恰好没事干 —— x.com 是重型 SPA,
// 加载要好几秒,足够它被杀。一旦被杀,内存里的 id 就没了,
// 于是 worker 问"我是那个执行器吗"得到 false,**静默返回**,界面上就永远卡在
// "正在后台打开…"。
//
// 所以 id 落进 storage.session:它能跨 SW 重启活着,又只存在浏览器会话里不写盘。
let workerTabId = null;
let lastDispatchAt = 0;

const WID_KEY = 'xf:workerTabId';

function storeGet(key) {
  return new Promise((resolve) => {
    const area = (chrome.storage && chrome.storage.session) || (chrome.storage && chrome.storage.local);
    if (!area) return resolve(null);
    try {
      area.get([key], (r) => {
        void chrome.runtime.lastError;
        resolve((r && r[key]) || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function storeSet(key, value) {
  return new Promise((resolve) => {
    const area = (chrome.storage && chrome.storage.session) || (chrome.storage && chrome.storage.local);
    if (!area) return resolve();
    try {
      area.set({ [key]: value }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function setWorkerTabId(id) {
  workerTabId = id;
  await storeSet(WID_KEY, id);
}

async function getWorkerTabId() {
  if (workerTabId != null) return workerTabId;
  workerTabId = await storeGet(WID_KEY);
  return workerTabId;
}

async function isWorkerTab(tabId) {
  if (tabId == null) return false;
  const id = await getWorkerTabId();
  return id != null && id === tabId;
}

/**
 * 这个任务是不是**正在飞**。
 *
 * 只有 `running` 才算。这里踩过一个把功能彻底锁死的坑:
 * 侧边栏刚写进去的任务状态是 `pending`(还没派车呢),而原来的判断只排除了
 * done/failed —— 于是 pending 被当成"上一个还没做完",**它拒绝的正是它自己刚创建的那个任务**。
 * 加上失败时会把任务清掉,下一次又从头来一遍、又被拒,变成永远点不了。
 *
 * `running` 超过 JOB_TIMEOUT 还没结束,说明后台那个标签页卡住了或者 SW 被回收过,
 * 这时放行让下一次能重开 —— 否则一次卡死同样会把功能锁住。
 */
function isInFlight(job, now) {
  const t = now || Date.now();
  if (!job || job.status !== 'running') return false;
  if (!job.startedAt) return false;
  return t - job.startedAt <= JOB_TIMEOUT_MS;
}

/**
 * 闲着太久了才收掉执行器标签页。
 *
 * 为什么要先看 idleUntil:service worker 可能在这 20 秒里被回收,定时器跟着没了 ——
 * 标签页会一直挂着。所以截止时间落进 session 存储,每次有消息把 SW 叫醒时顺手扫一遍。
 */
/** 闲置到期了吗。
 *
 * ⚠ 这里的语义**踩过一次大坑**,而且害得很惨:我把"没设过截止时间"当成了"到期"。
 * 而派车时恰恰会把这个标记清成 0(意思是**正在用**)。于是只要有任何消息把 SW 叫醒
 * ——包括普通 x.com 页面加载时问的那句 whoami——清扫就会看到 0、判定"到期"、
 * **把正在干活的后台标签页关掉**。worker 一死,任务永远停在"进行中",
 * 用户看到的是"取关成功了,但工具一直卡着"。
 *
 * 正确的语义只有一条:**只有明确标记了"闲置到什么时候"、而且真的过了那个点,才收。**
 * 没有标记 = 没在闲置 = 一个字都不许动。
 */
function idleExpired(until, now) {
  const t = Number(until) || 0;
  if (t <= 0) return false;
  return (now || Date.now()) >= t;
}

async function sweepIdleWorker() {
  const until = (await storeGet(IDLE_KEY)) || 0;
  if (!idleExpired(until, Date.now())) return false;
  const id = await getWorkerTabId();
  if (id == null) return false;
  await closeWorker();
  await storeSet(IDLE_KEY, 0);
  return true;
}

async function markIdle() {
  await storeSet(IDLE_KEY, Date.now() + IDLE_KEEP_MS);
}

async function closeWorker() {
  const id = await getWorkerTabId();
  await setWorkerTabId(null);
  if (id == null) return;
  return new Promise((resolve) => {
    try {
      chrome.tabs.remove(id, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** 把标签页导航到目标主页。已经在这个执行器标签页里就直接改 URL。 */
function navigateWorker(tabId, url) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.update(tabId, { url, active: false }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function createWorker(url) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.create({ url, active: false }, (tab) => {
        void chrome.runtime.lastError;
        resolve(tab && tab.id != null ? tab.id : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** 问标签页里的内容脚本一句,拿到它的回包(含本文档的 nonce);没人在就 null */
function pingTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'xf:ping' }, (resp) => {
        const err = chrome.runtime.lastError;
        resolve(!err && resp && resp.ready ? resp : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function reloadTab(tabId) {
  return new Promise((resolve) => {
    try {
      // 用 reload 而不是 update 到同一个 URL —— 后者会因为"地址本来就一样"立刻满足
      // 我们的等待条件,于是根本没换文档
      chrome.tabs.reload(tabId, {}, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * 等**新文档**就绪 —— 判据是内容脚本报出一个和之前不同的 nonce。
 *
 * 只等"URL 相同 + ping 有回包"是不够的:重新加载之前那个文档本来就满足这两条,
 * 于是我们会对着旧 DOM 读出一个过期状态,再拿它当结论。
 * 真机报的"明明关注成功了却说没成功"就是这么来的。
 */
async function waitForNewDocument(tabId, wantUrl, oldNonce, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // 标签页没了就立刻失败,不要把那 20 多秒等满(审查指出的 fail-fast)
    const gone = await new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (t) => {
          const err = chrome.runtime.lastError;
          resolve(!!err || !t || t.id == null);
        });
      } catch {
        resolve(true);
      }
    });
    if (gone) return null;
    const pong = await pingTab(tabId);
    if (pong && pong.nonce && pong.nonce !== oldNonce) {
      const href = String(pong.href || '').split('?')[0].replace(/\/$/, '');
      const want = String(wantUrl).split('?')[0].replace(/\/$/, '');
      if (href === want) return pong;
    }
    await sleep(200);
  }
  return null;
}

/**
 * 等标签页里的人应答。
 *
 * 这一步存在的理由:原来全靠页面**主动**来问"我是那个执行器吗",一旦这一步断了
 * (内容脚本没注入、SW 被回收导致内存里的 id 没了),表现就是界面上永远停在
 * "正在后台打开…",而没有任何原因。现在改成后台**推**:先确认对方在,
 * 不在就直接说清"内容脚本没响应" —— 那是一个可执行的结论,不是一句卡住。
 */
function waitForTabUrl(tabId, wantUrl, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      try {
        chrome.tabs.get(tabId, (t) => {
          const err = chrome.runtime.lastError;
          // 标签页被关掉了 → 立刻失败,不要把那 20 秒等满(审查指出的 fail-fast)
          if (err || !t || t.id == null) return resolve(false);
          const url = t && t.url ? String(t.url).split('?')[0].replace(/\/$/, '') : '';
          const want = String(wantUrl).split('?')[0].replace(/\/$/, '');
          if (url && url === want) return resolve(true);
          if (Date.now() - t0 > timeoutMs) return resolve(false);
          setTimeout(check, 400);
        });
      } catch {
        resolve(false);
      }
    };
    check();
  });
}

async function waitForWorker(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pingTab(tabId)) return true;
    await sleep(200);
  }
  return false;
}

async function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        resolve(err ? null : resp || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function dispatch(tabId) {
  const job = await readJob();
  if (!job || !job.id || !job.sn) return { ok: false, reason: '没有任务' };
  // 记下这条任务的身份,后面所有失败写入都要拿它比对
  const jobId = job.jobId || null;

  // 正在飞的才拒绝,不排队 —— 排队会让人以为点多少次都没事
  if (isInFlight(job)) {
    return { ok: false, reason: `上一个还在做(已经 ${Math.round((Date.now() - job.startedAt) / 1000)} 秒),等它结束` };
  }

  const gap = Date.now() - lastDispatchAt;
  if (lastDispatchAt && gap < MIN_GAP_MS) {
    const wait = Math.ceil((MIN_GAP_MS - gap) / 1000);
    return { ok: false, reason: `慢一点 —— 距离上一次还不到 ${wait} 秒。这个工具不该被用成批量机器。` };
  }

  const url = 'https://x.com/' + job.sn;

  // 先写一个"已派车",界面立刻能看到动起来了;worker 那边会接手改成 running。
  // 如果一直停在 dispatched,就说明标签页那边没起来 —— 这比"卡住不动"可读得多。
  await writeJob({ status: 'dispatched', dispatchedAt: Date.now(), jobId });

  if ((await getWorkerTabId()) != null) {
    // 复用同一个后台标签页:省掉反复开关标签页,也少一次冷启动
    const wid = await getWorkerTabId();
    const alive = await new Promise((resolve) => {
      try {
        chrome.tabs.get(wid, (t) => {
          void chrome.runtime.lastError;
          resolve(!!(t && t.id != null));
        });
      } catch {
        resolve(false);
      }
    });
    if (alive) {
      // ① 先试快路:让那个页面自己切过去(SPA 路由,几百毫秒)
      // 先记下**当前文档**的 nonce —— 后面要靠它证明"换了文档",而不是只看到地址相同
      const before = await pingTab(wid);
      const spa = await sendToTab(wid, { type: 'xf:goto', sn: job.sn, id: job.id });
      if (spa && spa.ok) {
        await writeJob({ viaNav: 'spa', jobId });
        // 快路是**同一个文档**内的路由切换,所以不验 nonce(它不会变)—— 自证由页面自己做
        return handOff(wid, job, { oldNonce: null });
      }
      // ② 快路走不通就退回整页导航 —— 这是已经验证过的路,不拿结论冒险。
      //    快路的失败原因也记下来,好知道它到底是"偶尔不行"还是"从来不行"。
      await writeJob({ viaNav: 'full', spaWhy: (spa && spa.why) || '页面没有回应', jobId });
      await navigateWorker(wid, url);
      return handOff(wid, job, { oldNonce: before ? before.nonce : null });
    }
    await setWorkerTabId(null);
  }

  const id = await createWorker(url);
  if (id == null) return { ok: false, reason: '开不出后台标签页' };
  await setWorkerTabId(id);
  await writeJob({ viaNav: 'full', spaWhy: '这是新开的标签页,只能整页加载', jobId });
  return handOff(id, job);
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return undefined;

    // 页面问"我是那个后台执行器吗"。用 sender.tab.id 比,不靠页面自己声称。
    if (msg.type === 'xf:whoami') {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      isWorkerTab(tabId)
        .then((yes) => sendResponse({ ok: true, isWorker: yes, tabId }))
        .catch(() => sendResponse({ ok: true, isWorker: false, tabId }));
      return true; // 异步回包
    }

    // SW 可能刚被唤醒(上次那个 20 秒定时器已经没了),顺手收掉过期的执行器。
    if (msg.type === 'xf:run-job' || msg.type === 'xf:whoami') {
      sweepIdleWorker().catch(() => {});
    }

    if (msg.type === 'xf:run-job') {
      dispatch()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
      return true; // 异步回包
    }

    // 页面不再请求关闭自己(见上面 storage.onChanged 的说明)。
    // 这条留着只是为了让旧页面不至于报错,回一个"不用了"。
    if (msg.type === 'xf:job-finished') {
      sendResponse({ ok: true, ignored: '关闭由后台按任务状态决定' });
      return true;
    }

    return undefined;
  });
}

// ── 后台盯着任务状态:该复查就复查,该收摊就收摊 ───────────────
//
// 这一步是"确认"真正该待的地方。页面自己没法做复查 —— 复查要**重新加载页面**,
// 而页面一加载,它自己就没了。所以由后台驱动:
//   · 页面点完但拿不准 → 任务停在 clicked → 后台重新加载那个主页 → 让它读一次真实状态
//   · 有了结论(done/failed)→ 收掉执行器标签页
let verifying = null;

async function verifyByReload(job) {
  const jobId = (job && job.jobId) || null;
  const tabId = await getWorkerTabId();
  if (tabId == null) return failJob('复查失败:执行器标签页已经不在了', jobId);

  const url = 'https://x.com/' + job.sn;
  // ① 先记下**当前那个文档**的 nonce
  const before = await pingTab(tabId);
  const oldNonce = before ? before.nonce : null;

  // ② 真的重新加载
  await reloadTab(tabId);

  // ③ 等到**换了文档**为止。这一步是这次修复的核心 ——
  //    少了它,我们会对着旧页面读出过期状态,然后拿它当结论。
  const fresh = await waitForNewDocument(tabId, url, oldNonce, 25000);
  if (!fresh) {
    return failJob(
      '复查失败:页面没有真正重新加载(读到的还是原来那个文档),所以这次结果不算数。' +
        '再点一次试试;如果一直这样,说明那个后台标签页卡住了。',
      jobId
    );
  }

  const r = await sendToTab(tabId, { type: 'xf:check-job', job });
  if (!r || !r.ok) return failJob('复查失败:' + ((r && r.reason) || '页面没有回应'), jobId);
  return true;
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[JOB_KEY]) return;
    const job = changes[JOB_KEY].newValue;
    if (!job) return;

    // 需要复查:重新加载他的主页,读一次真实状态
    if (job.status === 'clicked' && !verifying) {
      verifying = verifyByReload(job)
        .catch(() => failJob('复查过程出错'))
        .finally(() => {
          verifying = null;
        });
      return;
    }

    if (!isSettled(job)) return;
    // **不马上关** —— 留一小会儿,下一个动作可以直接复用这个标签页。
    // X 是重型 SPA,重新开标签页是冷启动(重新拉包、重新解析);复用走缓存,明显快,
    // 而且不会在标签栏里一闪一闪。闲着超过 IDLE_KEEP_MS 才收掉。
    markIdle().catch(() => {});
    setTimeout(() => {
      sweepIdleWorker().catch(() => {});
    }, IDLE_KEEP_MS);
  });
}

// 复查要是拖太久,给个兜底 —— 不能让任务永远停在 clicked
setInterval(() => {
  readJob()
    .then((job) => {
      if (!job || job.status !== 'clicked') return;
      const since = job.clickedAt || 0;
      if (Date.now() - since < 40000) return;
      return failJob('点了之后一直确认不了结果(等了 40 秒)。请你在他的主页上看一眼到底关注上没有。');
    })
    .catch(() => {});
}, 10000);

// 用户手动关掉那个后台标签页时,把内存里的 id 也清掉
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    isWorkerTab(tabId).then((yes) => {
      if (yes) setWorkerTabId(null);
    });
  });
}

// ── 图标点击:开合侧边栏 ──────────────────────────────────────
async function toggleSidebar() {
  const tabs = await chrome.tabs.query({ url: X_URLS });
  // 后台执行器那个标签页不算"你的 x.com" —— 否则点图标会跑到它上面去
  const wid = await getWorkerTabId();
  const usable = tabs.filter((t) => t.id !== wid);
  let tab = usable.find((t) => t.active) || usable[0];

  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }

  // 内容脚本可能还没注入(新开的标签页),重试到它应答为止。
  for (let i = 0; i < 25; i++) {
    if (await send(tab.id, { type: 'xf:toggle-sidebar' })) return;
    await sleep(600);
  }
}

if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    toggleSidebar().catch(() => {});
  });
}

// 供测试直接验证调度判断。service worker 本身没法在 node 里跑起来,
// 但这几个纯函数是"能不能开始"的全部依据,值得单独钉住。
if (typeof module === 'object' && module.exports) {
  module.exports = { isInFlight, isSettled, idleExpired, MIN_GAP_MS, JOB_TIMEOUT_MS, IDLE_KEEP_MS };
}
