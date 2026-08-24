import https from "https";
import http from "http";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// 兼容 Node ESM 下的 __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 用 createRequire 绕过 package.json 的 exports 限制（可直接 require 子路径文件）
const require = createRequire(import.meta.url);

// ============================================================
// 1. 原生 HTTP/HTTPS 请求封装（用于 Reddit / HackerNews）
//    - 跟随 3xx 自动重定向
//    - 6 秒超时
//    - 处理 gzip/deflate（避免有些源返回压缩内容无法解析）
// ============================================================
/**
 * 发起 GET 请求并返回文本内容
 * @param {string} url 目标 URL
 * @param {number} [timeoutMs=6000] 超时毫秒数
 * @returns {Promise<string>}
 */
const fetchText = (url, timeoutMs = 6000) => {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    // 跟随 3xx 重定向（reddit 有时会重定向）
    const doGet = (u, depth) => {
      if (depth > 5) return reject(new Error("Redirect too deep"));
      const cur = new URL(u);
      const options = {
        hostname: cur.hostname,
        port: cur.port || (url.startsWith("https") ? 443 : 80),
        path: cur.pathname + cur.search,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept-Encoding": "identity", // 禁用压缩，省事
          Accept: "*/*",
          Connection: "close",
        },
        timeout: timeoutMs,
      };
      const req = client.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next = res.headers.location;
          if (next.startsWith("/"))
            next = (url.startsWith("https") ? "https:" : "http:") + "//" + cur.hostname + next;
          try {
            new URL(next);
            return doGet(next, depth + 1);
          } catch {}
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error("HTTP " + res.statusCode + " " + (res.statusMessage || ""))
          );
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout (" + timeoutMs + "ms)"));
      });
    };
    doGet(url, 0);
  });
};

// ============================================================
// 2.5. 通用 RSS 拉取 + 解析（新增：BBC/Reuters/FT/Bloomberg/CNBC 等海外新闻源）
// ============================================================
/**
 * 从 RSS 2.0 / Atom XML 中抽取 (title, link, pubDate, description) 条目列表
 * 为了避免引入三方依赖（fast-xml-parser 等），这里用简单稳妥的正则抽取：
 *   - RSS 2.0:  <item>...</item>  内找 <title> / <link> / <pubDate> / <description>
 *   - Atom 1.0: <entry>...</entry> 内找 <title> / <link href="..."> / <updated> / <summary>
 * @param {string} xml RSS/Atom 源文本
 * @returns {Array<{idx:number,title:string,link:string,date:string,desc:string}>}
 */
function parseRssXml(xml) {
  const items = [];
  const pushItem = (it) => {
    if (it && (it.title || it.link)) items.push(it);
  };
  // 先清理 CDATA <![CDATA[ xxx ]]>
  const text = String(xml || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, g1) => String(g1 || ""));
  // 1) RSS 2.0 <item>
  const rssRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  let idx = 0;
  while ((m = rssRe.exec(text))) {
    const chunk = m[1] || "";
    const title = (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    let link = (chunk.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "";
    if (!link) link = (chunk.match(/<link\s+[^>]*?href="([^"]+)"/i) || [])[1] || "";
    const date =
      (chunk.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] ||
      (chunk.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1] ||
      "";
    const desc =
      (chunk.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] ||
      (chunk.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || [])[1] ||
      "";
    pushItem({ idx: ++idx, title: sanitizeHtml(title), link: String(link).trim(), date: String(date).trim(), desc: sanitizeHtml(desc, 220) });
  }
  // 2) Atom <entry>
  const atomRe = /<entry>([\s\S]*?)<\/entry>/gi;
  while ((m = atomRe.exec(text))) {
    const chunk = m[1] || "";
    const title = (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const link = (chunk.match(/<link\s+[^>]*?href="([^"]+)"/i) || [])[1] || "";
    const date =
      (chunk.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] ||
      (chunk.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] ||
      "";
    const desc =
      (chunk.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] ||
      (chunk.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] ||
      "";
    pushItem({ idx: ++idx, title: sanitizeHtml(title), link: String(link).trim(), date: String(date).trim(), desc: sanitizeHtml(desc, 220) });
  }
  return items;
}
/**
 * 清理 HTML 标签、压缩多余空白、截断（用于 desc / title 的 RSS 清洗）
 */
function sanitizeHtml(s, maxLen = 0) {
  let t = String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLen && t.length > maxLen) t = t.slice(0, maxLen) + "...";
  return t;
}
/**
 * 从 RSS 源拉取并转换为符合 dailyhot-api 标准的 data 条目列表
 * @param {string} rssUrl RSS 源 URL
 * @param {string} hotLabel 每一行 hot 字段默认显示（例如 "BBC World" / "Reuters Business"）
 * @param {number} limit 最多多少条
 */
async function fetchRssToNewsItems(rssUrl, hotLabel = "News", limit = 30) {
  const xml = await fetchText(rssUrl, 12000);
  const parsed = parseRssXml(xml);
  const list = parsed.slice(0, limit).map((it, i) => {
    return {
      id: String(i + 1),
      title: it.title || "(无标题)",
      url: it.link || "#",
      mobileUrl: it.link || "#",
      hot: it.date ? `${hotLabel} · ${it.date.slice(0, 25)}` : hotLabel,
      desc: it.desc || hotLabel,
    };
  });
  return list;
}

// ============================================================
// 2.8. 海外权威新闻源配置
//   按您偏好：国际局势 / 经济 / 科技 三类。均使用官方公开 RSS 地址。
// ============================================================
const GLOBAL_NEWS_FEEDS = {
  bbc_world: {
    title: "BBC World（国际局势）",
    name: "bbc-world",
    type: "国际局势",
    description: "BBC News 世界新闻：全球重大事件、地缘政治、冲突与外交报道",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
  },
  bbc_business: {
    title: "BBC Business（经济）",
    name: "bbc-business",
    type: "经济",
    description: "BBC 商业新闻：全球经济、金融市场、央行政策与公司动态",
    url: "https://feeds.bbci.co.uk/news/business/rss.xml",
  },
  bbc_tech: {
    title: "BBC Technology（科技）",
    name: "bbc-tech",
    type: "科技",
    description: "BBC 科技新闻：AI、芯片、互联网巨头、监管与消费电子",
    url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
  },
  reuters_world: {
    title: "Reuters World（国际局势）",
    name: "reuters-world",
    type: "国际局势",
    description: "路透社世界新闻：中立、快速、深度的全球重大事件报道（Google News 聚合源）",
    url: "https://news.google.com/rss/search?q=site:reuters.com+world+OR+international+when:48h&ceid=US:en&hl=en-US&gl=US",
    fallback: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?ceid=US:en&hl=en-US&gl=US",
  },
  reuters_business: {
    title: "Reuters Business（经济）",
    name: "reuters-business",
    type: "经济",
    description: "路透社财经：全球市场、宏观经济、央行、并购与公司业绩（Google News 聚合源）",
    url: "https://news.google.com/rss/search?q=site:reuters.com+business+OR+finance+OR+markets+when:48h&ceid=US:en&hl=en-US&gl=US",
    fallback: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?ceid=US:en&hl=en-US&gl=US",
  },
  reuters_tech: {
    title: "Reuters Technology（科技）",
    name: "reuters-tech",
    type: "科技",
    description: "路透社科技：硅谷、AI、半导体、平台监管与创业公司动态（Google News 聚合源）",
    url: "https://news.google.com/rss/search?q=site:reuters.com+technology+OR+tech+OR+ai+OR+semiconductor+when:7d&ceid=US:en&hl=en-US&gl=US",
    fallback: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?ceid=US:en&hl=en-US&gl=US",
  },
  ft_economy: {
    title: "FT Global Economy（经济 · 金融时报）",
    name: "ft-economy",
    type: "经济",
    description: "金融时报全球经济：专业视角看全球经济、政策与市场",
    url: "https://www.ft.com/global-economy?format=rss",
  },
  ft_markets: {
    title: "FT Markets（经济 · 市场）",
    name: "ft-markets",
    type: "经济",
    description: "金融时报市场：股票、债券、外汇、大宗商品行情与分析",
    url: "https://www.ft.com/markets?format=rss",
  },
  bloomberg_markets: {
    title: "Bloomberg（经济 · 彭博市场）",
    name: "bloomberg-markets",
    type: "经济",
    description: "彭博市场：华尔街、利率、股市、债市与全球宏观",
    url: "https://feeds.bloomberg.com/markets/news.rss",
  },
  cnbc_top: {
    title: "CNBC Top（经济 · 财经头条）",
    name: "cnbc-top",
    type: "经济",
    description: "CNBC 财经头条：美股、美联储、公司财报与经济数据",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  },
  economist_fe: {
    title: "The Economist Finance（经济 · 经济学人）",
    name: "economist-fe",
    type: "经济",
    description: "经济学人财经：长周期、大视角的全球经济与政策分析",
    url: "https://www.economist.com/finance-and-economics/rss.xml",
  },
  economist_intl: {
    title: "The Economist International（国际局势 · 经济学人）",
    name: "economist-intl",
    type: "国际局势",
    description: "经济学人国际：大国关系、全球治理与地缘观察",
    url: "https://www.economist.com/international/rss.xml",
  },
};

// ============================================================
// 2.9. 海外 RSS 路由快速构建器
// ============================================================
/**
 * 构建一个海外新闻路由的统一处理函数（带主源 + fallback 源）
 * @param {keyof typeof GLOBAL_NEWS_FEEDS} feedKey
 */
function buildRssRoute(feedKey) {
  const meta = GLOBAL_NEWS_FEEDS[feedKey];
  /** @type {(sendJson: any) => Promise<void>} */
  return async (sendJson) => {
    const urls = [meta.url];
    if (meta.fallback) urls.push(meta.fallback);
    let lastErr = null;
    for (const u of urls) {
      try {
        const list = await fetchRssToNewsItems(u, meta.title, 30);
        if (!list || list.length === 0) throw new Error("empty list");
        const nowISO = new Date().toISOString();
        return sendJson(200, {
          code: 200,
          name: meta.name,
          title: meta.title,
          type: meta.type,
          description: meta.description,
          total: list.length,
          updateTime: nowISO,
          fromCache: false,
          data: list,
        });
      } catch (e) {
        lastErr = e;
      }
    }
    return sendJson(500, {
      code: 500,
      message: `${meta.title} 拉取失败`,
      error: (lastErr && lastErr.message) || String(lastErr || ""),
    });
  };
}

// ============================================================
// 2. 惰性加载 dailyhot-api 内部的 Hono app
//    - 首次请求加载，后面复用缓存
//    - 优先用 createRequire + 绝对路径，绕过 package.json exports 限制
// ============================================================
let _dailyHotAppPromise = null;

/**
 * 把绝对路径转成 file:// URL（兼容 Windows）
 * @param {string} absPath
 */
function pathToFileURL(absPath) {
  let p = path.resolve(absPath).split(path.sep).join("/");
  if (!p.startsWith("/")) p = "/" + p; // Windows: /C:/xxx
  return "file://" + p;
}

/**
 * 获取 dailyhot-api 内部 Hono app
 * @returns {Promise<{fetch: (req: Request, env?: any) => Promise<Response>}>}
 */
async function getDailyHotApp() {
  if (_dailyHotAppPromise) return _dailyHotAppPromise;
  _dailyHotAppPromise = (async () => {
    // ============================================================
    // ⭐ Vercel 运行时 双保险（winston logger 崩溃的第一道防线）：
    //   1. 先尝试在 /tmp 下创建 logs 目录（Vercel 唯一可写目录）
    //   2. 把进程当前工作目录切到 /tmp，让任何相对路径 `./logs` 都会写到 /tmp/logs
    //      （避免 winston 默认 mkdirSync('./logs') 写 /var/task 抛 ENOENT 崩溃）
    // 构建补丁 patch-dailyhot-api.js 会再做源码层面兜底，这里双保险。
    // ============================================================
    try {
      const osMod = await import("os");
      const tmpDir = (osMod.tmpdir && osMod.tmpdir()) || "/tmp";
      const logDir = path.join(tmpDir, "logs");
      try {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      } catch (_) {}
      // 切到 /tmp：后续任何相对路径写操作都会落去可写目录
      try {
        process.chdir(tmpDir);
      } catch (_) {}
    } catch (_) {}

    let app = null;
    const tried = [];

    // ============================================================
    // ⚠️ dailyhot-api npm 包的 package.json exports 常写坏（如 "dist/index.js" 缺 "./"）
    //    Node 22 会把这种 exports 直接当语法错误 → 任何按包名解析都会死。
    //    因此我们优先走「绝对路径直读文件」，完全跳过 Node 的 exports 解析机制。
    // ============================================================

    // ---- 先 100% 确定 dailyhot-api 的包根目录（不经过 Node 解析器）----
    let pkgRoot = null;
    const pkgRootGuesses = [
      // Vercel 部署后：/var/task/node_modules/dailyhot-api
      path.join(__dirname, "node_modules", "dailyhot-api"),
      // pnpm monorepo 或开发机 hoisted：向上两级找
      path.join(__dirname, "..", "node_modules", "dailyhot-api"),
      path.join(__dirname, "..", "..", "node_modules", "dailyhot-api"),
    ];
    for (const g of pkgRootGuesses) {
      if (fs.existsSync(path.join(g, "package.json"))) {
        pkgRoot = g;
        break;
      }
    }
    tried.push("pkgRoot:" + (pkgRoot || "not-found (checked=" + pkgRootGuesses.length + ")"));

    // ---- 兜底再尝试 require.resolve（若构建补丁已生效，exports 修好了就能用）----
    if (!pkgRoot) {
      try {
        const entryPath = require.resolve("dailyhot-api");
        let cur = path.dirname(entryPath);
        for (let i = 0; i < 6 && cur && cur !== path.dirname(cur); i++) {
          if (fs.existsSync(path.join(cur, "package.json"))) { pkgRoot = cur; break; }
          cur = path.dirname(cur);
        }
        tried.push("pkgRoot-fallback:" + (pkgRoot || "fail"));
      } catch (e) {
        tried.push("pkgRoot-fallback-err:" + e.message);
      }
    }

    // ---- 方式 A（首选）：绝对路径动态 import dist/app.js / src/app.js ----
    //      100% 绕过 package.json exports，只要文件存在就能 load
    if (pkgRoot) {
      const candidates = [
        path.join(pkgRoot, "dist", "app.js"),
        path.join(pkgRoot, "src", "app.js"),
        path.join(pkgRoot, "app.js"),
      ];
      for (const abs of candidates) {
        tried.push("A:" + abs + (fs.existsSync(abs) ? "(exists)" : "(missing)"));
        if (fs.existsSync(abs)) {
          try {
            const mod = await import(pathToFileURL(abs));
            app = mod?.default || mod?.app;
            if (app && typeof app.fetch === "function") break;
          } catch (e) {
            tried.push("A-err:" + e.message);
          }
        }
      }
    }

    // ---- 方式 B：CommonJS require 绝对路径（ESM 加载失败时兜底，对 CJS 模块更稳）----
    if ((!app || typeof app.fetch !== "function") && pkgRoot) {
      const cjsCandidates = [
        path.join(pkgRoot, "dist", "app.js"),
        path.join(pkgRoot, "src", "app.js"),
        path.join(pkgRoot, "app.js"),
      ];
      for (const abs of cjsCandidates) {
        tried.push("B:" + abs + (fs.existsSync(abs) ? "(exists)" : "(missing)"));
        if (fs.existsSync(abs)) {
          try {
            const mod = require(abs);
            app = mod?.default || mod?.app || mod;
            if (app && typeof app.fetch === "function") break;
          } catch (e) {
            tried.push("B-err:" + e.message);
          }
        }
      }
    }

    // ---- 方式 C：包根 dist/index.js / src/index.js（整包入口文件，再从导出里拿 app）----
    if ((!app || typeof app.fetch !== "function") && pkgRoot) {
      const entryCandidates = [
        path.join(pkgRoot, "dist", "index.js"),
        path.join(pkgRoot, "src", "index.js"),
        path.join(pkgRoot, "index.js"),
      ];
      for (const abs of entryCandidates) {
        tried.push("C:" + abs + (fs.existsSync(abs) ? "(exists)" : "(missing)"));
        if (fs.existsSync(abs)) {
          try {
            const mod = await import(pathToFileURL(abs));
            app = mod?.app || mod?.default?.app || mod?.default;
            if (app && typeof app.fetch === "function") break;
          } catch (e) {
            tried.push("C-err:" + e.message);
          }
          try {
            if (!app || typeof app.fetch !== "function") {
              const mod2 = require(abs);
              app = mod2?.app || mod2?.default?.app || mod2?.default || mod2;
              if (app && typeof app.fetch === "function") break;
            }
          } catch (e) {
            tried.push("C-cjs-err:" + e.message);
          }
        }
      }
    }

    // ---- 方式 D（最后兜底，此时 exports 肯定已被构建补丁修好）：按包名 import ----
    if (!app || typeof app.fetch !== "function") {
      tried.push("D:rootESM");
      try {
        const pkg = await import("dailyhot-api");
        app = pkg?.app || pkg?.default?.app || pkg?.default;
      } catch (e) {
        tried.push("D-err:" + e.message);
      }
      tried.push("E:rootCJS");
      try {
        const pkg = require("dailyhot-api");
        app = pkg?.app || pkg?.default?.app || pkg?.default || pkg;
      } catch (e) {
        tried.push("E-err:" + e.message);
      }
    }

    if (!app || typeof app.fetch !== "function") {
      throw new Error(
        [
          "❌ 无法加载 dailyhot-api 的内部 Hono app（app.fetch 未找到）。",
          "已尝试: " + tried.join(" | "),
          "",
          "💡 解决：",
          "  A. 删除项目下 node_modules/dailyhot-api 后重新 npm install dailyhot-api",
          "  B. 确认 Vercel Build Command = npm run vercel-build（会调用 patch-dailyhot-api.js 修正 exports）",
          "  C. 本地在项目根目录执行 node patch-dailyhot-api.js 手动打一次补丁再 redeploy",
        ].join("\n")
      );
    }
    return app;
  })();
  return _dailyHotAppPromise;
}

// ============================================================
// 3. Web Request <-> Node req/res 转换层
//    dailyhot-api 内部是基于 Web standard Request/Response 的 Hono，
//    所以 Vercel 给的 Node IncomingMessage/ServerResponse 要互转一下。
// ============================================================

/**
 * Node IncomingMessage → Web Request
 * @param {import("http").IncomingMessage} req
 * @returns {Request}
 */
function toWebRequest(req) {
  const protocol =
    req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"].length
      ? req.headers["x-forwarded-proto"].split(",")[0].trim()
      : "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const port = req.headers["x-forwarded-port"] || "";
  let origin = protocol + "://" + host;
  if (port && String(port) !== "80" && String(port) !== "443") origin += ":" + port;
  const fullUrl = origin + (req.url || "/");

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, String(v));
  }

  // 路由里只用 GET，所以 body 直接 undefined 即可（避免流式问题）
  return new Request(fullUrl, {
    method: (req.method || "GET").toUpperCase(),
    headers,
    // @ts-ignore 让 Hono 可以直接拿到原始 Node req（如果它想读的话）
    // 注意：不要传入 duplex/body 等字段，避免 Node < 18 报错
  });
}

/**
 * 把 Web Response 写到 Node ServerResponse
 * @param {Response} webRes
 * @param {import("http").ServerResponse} res
 */
async function writeWebResponse(webRes, res) {
  res.statusCode = webRes.status;
  res.statusMessage = webRes.statusText || "";
  webRes.headers.forEach((val, key) => {
    // set-cookie 可能多条，需要特殊处理
    if (key.toLowerCase() === "set-cookie") {
      const existing = res.getHeader("set-cookie") || [];
      const arr = Array.isArray(existing) ? existing : [String(existing)];
      const vals = webRes.headers.getSetCookie
        ? webRes.headers.getSetCookie()
        : [val];
      res.setHeader("set-cookie", arr.concat(vals));
    } else {
      res.setHeader(key, val);
    }
  });
  if (!res.getHeader("content-type")) {
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  if (webRes.body == null) {
    res.end();
    return;
  }
  // 流式写入（响应大 JSON 更稳）
  // @ts-ignore
  if (typeof webRes.body[Symbol.asyncIterator] === "function") {
    try {
      // @ts-ignore
      for await (const chunk of webRes.body) {
        if (chunk != null) res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (e) {
      // 忽略 body 流化错误，让外层兜底
    }
  } else {
    const buf = Buffer.from(await webRes.arrayBuffer());
    if (buf.length) res.write(buf);
  }
  res.end();
}

// ============================================================
// 4. Vercel Serverless Function 入口
//    所有路径（/bilibili /weibo /reddit /hackernews ...）都走这里
// ============================================================
export default async function handler(req, res) {
  // 确保响应一定有兜底（防止任何分支没写 res.end）
  let responded = false;
  const origEnd = res.end.bind(res);
  res.end = function (a, b, c) {
    responded = true;
    return origEnd(a, b, c);
  };

  const url = req.url || "/";

  // 辅助：输出 JSON（任何路由走不到就兜底 500）
  /**
   * 写 JSON 响应
   * @param {number} statusCode
   * @param {any} payload
   */
  const sendJson = (statusCode, payload) => {
    if (responded) return;
    try {
      res.statusCode = statusCode;
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
      }
      res.end(JSON.stringify(payload));
    } catch (e) {
      // 极端兜底
      try {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        origEnd(JSON.stringify({ code: 500, message: "sendJson 写入失败", error: e.message }));
      } catch {}
    }
  };

  // 顶部 try/catch，防止任何异步异常导致请求挂起
  try {
    // -------------------- 1. Hacker News 路由 --------------------
    if (url.startsWith("/hackernews")) {
      try {
        const rawData = await fetchText(
          "https://hacker-news.firebaseio.com/v0/topstories.json"
        );
        const topIds = JSON.parse(rawData);
        const sliceIds = Array.isArray(topIds) ? topIds.slice(0, 30) : [];
        const items = await Promise.all(
          sliceIds.map(async (id) => {
            try {
              const itemTxt = await fetchText(
                `https://hacker-news.firebaseio.com/v0/item/${id}.json`
              );
              return JSON.parse(itemTxt);
            } catch {
              return null;
            }
          })
        );
        const list = items
          .filter(Boolean)
          .map((item) => ({
            id: String(item.id),
            title: item.title || "",
            url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
            mobileUrl:
              item.url || `https://news.ycombinator.com/item?id=${item.id}`,
            hot: (item.score || 0) + " 热度",
            desc: item.type || "story",
          }));
        const nowISO = new Date().toISOString();
        return sendJson(200, {
          code: 200,
          name: "hackernews",
          title: "Hacker News",
          type: "热门榜",
          description: "科技、编程与创业新闻聚合",
          total: list.length,
          updateTime: nowISO,
          fromCache: false,
          data: list,
        });
      } catch (e) {
        return sendJson(500, {
          code: 500,
          message: "Hacker News 获取失败",
          error: e.message || String(e),
        });
      }
    }

    // -------------------- 2. Reddit 路由 --------------------
    if (url.startsWith("/reddit")) {
      try {
        const xmlData = await fetchText(
          "https://www.reddit.com/r/all/.rss?limit=30",
          10000
        );
        const entries = [
          ...xmlData.matchAll(
            /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link href="([^"]+)"/g
          ),
        ];
        const list = entries.slice(0, 30).map((match, idx) => {
          const title = (match[1] || "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&");
          const href = match[2] || "";
          return {
            id: String(idx + 1),
            title,
            url: href,
            mobileUrl: href,
            hot: "Hot",
            desc: "Reddit r/all",
          };
        });
        const nowISO = new Date().toISOString();
        return sendJson(200, {
          code: 200,
          name: "reddit",
          title: "Reddit",
          type: "热门榜",
          description: "The front page of the internet",
          total: list.length,
          updateTime: nowISO,
          fromCache: false,
          data: list,
        });
      } catch (e) {
        return sendJson(500, {
          code: 500,
          message: "Reddit 获取失败",
          error: e.message || String(e),
        });
      }
    }

    // -------------------- 3. 海外权威新闻路由（共 12 条，国际局势/经济/科技） --------------------
    const RSS_ROUTE_MAP = {
      "/bbc-world":         "bbc_world",
      "/bbc-business":      "bbc_business",
      "/bbc-tech":          "bbc_tech",
      "/reuters-world":     "reuters_world",
      "/reuters-business":  "reuters_business",
      "/reuters-tech":      "reuters_tech",
      "/ft-economy":        "ft_economy",
      "/ft-markets":        "ft_markets",
      "/bloomberg-markets": "bloomberg_markets",
      "/cnbc-top":          "cnbc_top",
      "/economist-fe":      "economist_fe",
      "/economist-intl":    "economist_intl",
    };
    for (const [routePath, feedKey] of Object.entries(RSS_ROUTE_MAP)) {
      if (url.startsWith(routePath)) {
        const handle = buildRssRoute(feedKey);
        await handle(sendJson);
        return;
      }
    }

    // -------------------- 4. 兜底：dailyhot-api 内置接口（/bilibili /weibo /...）--------------------
    try {
      const app = await getDailyHotApp();
      const webReq = toWebRequest(req);
      const webRes = await app.fetch(webReq);
      const statusOk = webRes.status >= 200 && webRes.status < 300;

      // ============================================================
      // ⭐ 修复：dailyhot-api 自身返回非 2xx（例如 weibo 反爬 403 HTML 页）
      //   - 旧逻辑：直接把 403 HTML 写给前端，显示"request failed with status code 403"
      //     但 Vercel Logs 里看起来像 500，误导定位。
      //   - 新逻辑：统一"包一层"JSON：
      //       • 把 dailyhot-api 返回的真实 status / content-type / 响应体文本原样输出
      //       • 如果 JSON 可解析就作为子对象返回，不可解析就放进 responseText 字段
      //       • 同时 console.error 到 Vercel Functions Logs（这样以后能看到具体 4xx）
      // ============================================================
      if (statusOk) {
        // 2xx 正常：原样透传（最常用的 bilibili/zhihu 等正常走这里，性能最优）
        await writeWebResponse(webRes, res);
        return;
      }

      // ✅ 非 2xx：把真实错误读出来包 JSON 回传 + 写日志（让前端和 Vercel 都能看到真相）
      let rawBody = "";
      try {
        rawBody = webRes.body ? String(await webRes.text()) : "";
      } catch {
        rawBody = "";
      }
      // 尝试解析 JSON（dailyhot-api 有时也会返回错误 JSON）
      let innerJson = null;
      try {
        if (rawBody && /^\s*[\{\[]/.test(rawBody)) innerJson = JSON.parse(rawBody);
      } catch {
        innerJson = null;
      }
      // 截取 HTML 错误的前 600 字防止响应过大
      const snippet =
        innerJson == null && rawBody.length > 600
          ? rawBody.slice(0, 600) + "...(truncated)"
          : rawBody;

      const routeName = (url || "/").split("?")[0].replace(/^\/+/, "") || "index";

      // ⚠️ 打印到 Vercel Functions Logs（红色 ERROR 级别，这样以后一眼能看到真实错误）
      try {
        console.error(
          "[dailyhot-api upstream " + routeName + "] status=" + webRes.status +
          " contentType=" + (webRes.headers.get("content-type") || "") +
          " snippet=" + snippet.replace(/\s+/g, " ").slice(0, 500)
        );
      } catch (_) {}

      const payload = {
        code: 502, // 语义：上游服务器返回异常（weibo 403 属于"上游拒绝"）
        message: "上游接口返回异常：status " + webRes.status,
        route: routeName,
        upstreamStatus: webRes.status,
        upstreamContentType: webRes.headers.get("content-type") || "",
        upstreamJson: innerJson, // 如果 dailyhot-api 返回的是 JSON error 就在这里
        upstreamResponseText: snippet, // HTML 或原始文本（weibo 403 页面内容放这里）
        hint:
          routeName === "weibo"
            ? "微博对海外云 IP 反爬严格。解决：① 换一个国内可访问的备用源（m.weibo.cn 等）；② 配置 HTTP 代理；③ 在国内服务器部署后回源"
            : "上游接口失败，请检查网络或更换数据源",
      };
      return sendJson(502, payload);
    } catch (e) {
      return sendJson(500, {
        code: 500,
        message: "内置接口处理失败（dailyhot-api）",
        error: e.message || String(e),
        stack: e.stack ? String(e.stack).slice(0, 800) : undefined,
      });
    }
  } catch (e) {
    // 最外层兜底：绝对不允许请求挂起
    return sendJson(500, {
      code: 500,
      message: "Handler 顶层错误",
      error: e.message || String(e),
    });
  } finally {
    // 超级兜底：若走到这里响应仍未结束，强制结束
    if (!responded) {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        }
        origEnd(
          JSON.stringify({
            code: 500,
            message: "Handler 未产生响应（finally 兜底）",
          })
        );
        responded = true;
      } catch {}
    }
  }
}
