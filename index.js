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

    // ---- 方式 A（优先）：createRequire 找到包根，再绝对路径动态 import ----
    try {
      const pkgJsonPath = require.resolve("dailyhot-api/package.json");
      const pkgRoot = path.dirname(pkgJsonPath);
      const candidates = [
        path.join(pkgRoot, "dist", "app.js"),
        path.join(pkgRoot, "src", "app.js"),
        path.join(pkgRoot, "app.js"),
      ];
      for (const abs of candidates) {
        tried.push("A:" + abs);
        if (fs.existsSync(abs)) {
          const mod = await import(pathToFileURL(abs));
          app = mod?.default || mod?.app;
          if (app && typeof app.fetch === "function") break;
        }
      }
    } catch (e) {
      tried.push("A-err:" + e.message);
    }

    // ---- 方式 B：常规 ESM 子路径导入（依赖 exports 补丁）----
    if (!app || typeof app.fetch !== "function") {
      const subs = [
        "dailyhot-api/dist/app.js",
        "dailyhot-api/src/app.js",
        "dailyhot-api/app.js",
      ];
      for (const s of subs) {
        tried.push("B:" + s);
        try {
          const mod = await import(s);
          app = mod?.default || mod?.app;
          if (app && typeof app.fetch === "function") break;
        } catch (_) {}
      }
    }

    // ---- 方式 C：包根命名导出 ----
    if (!app || typeof app.fetch !== "function") {
      tried.push("C:root");
      try {
        const pkg = await import("dailyhot-api");
        app = pkg?.app || pkg?.default?.app;
      } catch (_) {}
    }

    if (!app || typeof app.fetch !== "function") {
      throw new Error(
        [
          "❌ 无法加载 dailyhot-api 的内部 Hono app（app.fetch 未找到）。",
          "已尝试: " + tried.join(" | "),
          "",
          "💡 解决（推荐 A）：",
          "  A. 直接 Fork 官方仓库 imsyy/DailyHotApi，在 src/routes/ 下加 reddit.ts 和 hackernews.ts（export const handleRoute = ...）",
          "  B. 确保 Build 时执行了 patch-dailyhot-api.js，Vercel Build Command 设为 npm run vercel-build",
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
        const sliceIds = Array.isArray(topIds) ? topIds.slice(0, 20) : [];
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
            id: item.id,
            title: item.title || "",
            url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
            hot: item.score || 0,
            mobileUrl:
              item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          }));
        return sendJson(200, {
          code: 200,
          message: "获取成功",
          title: "Hacker News",
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
          "https://www.reddit.com/r/all/.rss?limit=20",
          10000
        );
        const entries = [
          ...xmlData.matchAll(
            /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link href="([^"]+)"/g
          ),
        ];
        const list = entries.slice(0, 20).map((match, idx) => {
          const title = (match[1] || "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&");
          const href = match[2] || "";
          return {
            id: idx + 1,
            title,
            url: href,
            hot: "Hot",
            mobileUrl: href,
          };
        });
        return sendJson(200, {
          code: 200,
          message: "获取成功",
          title: "Reddit",
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

    // -------------------- 3. 兜底：dailyhot-api 内置接口（/bilibili /weibo /...）--------------------
    try {
      const app = await getDailyHotApp();
      const webReq = toWebRequest(req);
      const webRes = await app.fetch(webReq);
      await writeWebResponse(webRes, res);
      return;
    } catch (e) {
      return sendJson(500, {
        code: 500,
        message: "内置接口处理失败（dailyhot-api）",
        error: e.message || String(e),
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
