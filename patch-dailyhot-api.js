/**
 * 构建前补丁脚本（Vercel 构建阶段 install 之后执行）
 *   - 修复 1：dailyhot-api npm 包缺少的子路径 exports
 *   - 修复 2：⭐ 关键修复 —— 改写 dist/utils/logger.js 源码：
 *       winston 的 File transport 在 Vercel /var/task（只读）下 mkdirSync 抛 ENOENT，
 *       导致模块顶层同步崩溃、app 加载失败、bilibili 一直挂起。
 * 由 package.json 的 scripts.vercel-build 自动调用
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ============================================================
// 修复 1：package.json exports 子路径 + 主入口格式修正
//   - Node 22 严格要求：exports 目标路径必须以 "./" 开头
//   - dailyhot-api 官方 npm 包偶尔会写成 "dist/index.js"（缺 ./）
//     导致 require.resolve / import / require 全部直接抛语法错
// ============================================================
try {
  // 构建期先靠 __dirname 找 node_modules，不经过 Node 解析器，避免原 exports 坏了就死循环
  let pkgRoot = null;
  let pkgJsonPath = null;
  const guesses = [
    path.join(__dirname, "node_modules", "dailyhot-api", "package.json"),
    path.join(__dirname, "..", "node_modules", "dailyhot-api", "package.json"),
  ];
  for (const g of guesses) {
    if (fs.existsSync(g)) { pkgJsonPath = g; pkgRoot = path.dirname(g); break; }
  }
  // 兜底再用 require.resolve（若原 exports 是坏的这里会抛，没关系）
  if (!pkgJsonPath) {
    try { pkgJsonPath = require.resolve("dailyhot-api/package.json"); pkgRoot = path.dirname(pkgJsonPath); } catch (_) {}
  }
  if (!pkgJsonPath || !fs.existsSync(pkgJsonPath)) {
    throw new Error("找不到 dailyhot-api/package.json，已尝试: " + guesses.join(", "));
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  let changed = false;

  // 1.1 修正 pkg.main 字段（确保 ./ 开头）
  if (pkg.main && !pkg.main.startsWith("./")) {
    console.log(`  ! 修复 main: "${pkg.main}" -> "./${pkg.main}"`);
    pkg.main = "./" + pkg.main.replace(/^\.\/+/, "");
    changed = true;
  }

  pkg.exports = pkg.exports || {};

  // 1.2 修复整个 exports 对象里所有不以 "./" 开头的 target 路径
  //     支持三种写法：字符串 / {import, require, default} / 条件映射对象
  const normalizeExportTarget = (val, ctxKey) => {
    if (typeof val === "string") {
      if (val && !val.startsWith("./") && !val.startsWith("node:") && !val.startsWith("/")) {
        const fixed = "./" + val.replace(/^\.\/+/, "");
        console.log(`  ! 修复 exports["${ctxKey}"]: "${val}" -> "${fixed}"`);
        changed = true;
        return fixed;
      }
      return val;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const out = {};
      for (const [ck, cv] of Object.entries(val)) out[ck] = normalizeExportTarget(cv, `${ctxKey}:${ck}`);
      return out;
    }
    return val;
  };
  const newExports = {};
  for (const [k, v] of Object.entries(pkg.exports)) newExports[k] = normalizeExportTarget(v, k);
  // 确保 exports 的 key 也以 "." 或 "./" 开头（Node 规范）
  const normalizedKeyExports = {};
  for (const [k, v] of Object.entries(newExports)) {
    const nk = (k === "." || k.startsWith("./")) ? k : ("./" + k.replace(/^\.\/+/, ""));
    if (nk !== k) { console.log(`  ! 修复 exports key: "${k}" -> "${nk}"`); changed = true; }
    normalizedKeyExports[nk] = v;
  }
  pkg.exports = normalizedKeyExports;

  // 1.3 补全子路径 exports（便于调试子路径 import）
  const subExports = {
    "./app": "./dist/app.js",
    "./registry": "./dist/registry.js",
    "./config": "./dist/config.js",
    "./routes/*": "./dist/routes/*.js",
    "./utils/*": "./dist/utils/*.js",
    "./views/*": "./dist/views/*.js",
    "./robots.txt": "./dist/robots.txt.js",
    "./types": "./dist/types.js",
    "./package.json": "./package.json",
  };

  for (const [key, val] of Object.entries(subExports)) {
    if (!pkg.exports[key]) {
      const candidate = val.replace(/\*/, "index");
      const fullTarget = path.join(pkgRoot, candidate.replace(/^\.\//, ""));
      if (fs.existsSync(fullTarget) || key.includes("*") || key.endsWith("/package.json")) {
        pkg.exports[key] = val;
        changed = true;
        console.log(`  + add exports["${key}"] = "${val}"`);
      }
    }
  }

  // 1.4 确保主入口 "." 存在且格式合法
  const mainNorm = pkg.main ? (pkg.main.startsWith("./") ? pkg.main : "./" + pkg.main.replace(/^\.\/+/, "")) : "./dist/index.js";
  if (!pkg.exports["."] || typeof pkg.exports["."] !== "object" || !pkg.exports["."].import || !pkg.exports["."].require) {
    pkg.exports["."] = { import: mainNorm, require: mainNorm, default: mainNorm };
    changed = true;
    console.log(`  + 修复主入口 exports["."] = ${JSON.stringify(pkg.exports["."])}`);
  }

  if (changed) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
    console.log("✅ [1/2] dailyhot-api package.json exports 补丁完成");
  } else {
    console.log("ℹ️ [1/2] dailyhot-api exports 已齐全，无需补丁");
  }

  // ============================================================
  // 修复 2（关键）：改写 dist/utils/logger.js 源码
  //   ⭐ 2026-08-24 改为「注入式通用拦截器」（不再靠正则匹配代码模板，避免 return null 过滤没命中导致 Invalid transport）：
  //     a) 在 logger.js 文件内所有 import 之后、业务代码之前注入一段 IIFE 拦截器：
  //        - 拦截 winston.transports 的所有构造器（File / DailyRotateFile / Http / Console ...）
  //        - 任何 new 失败 -> 自动返回【带 log() 方法的 Mock Transport 实例】
  //          （winston 校验 transports 只检查「有 log 方法」，Mock 满足=校验通过，永不抛 Invalid transport）
  //        - 顺带拦截 fs.createWriteStream(path)：任何不在 /tmp 下的路径一律重定向到 /tmp/logs/<basename>
  //     b) 构建补丁只负责把拦截器注入，后续 dailyhot-api 内部怎么写 new 都不关我们事，100% 覆盖。
  // ============================================================
  const loggerPaths = [
    path.join(pkgRoot, "dist", "utils", "logger.js"),
    path.join(pkgRoot, "src", "utils", "logger.js"),
  ];
  let patchedLogger = false;
  for (const loggerFile of loggerPaths) {
    if (!fs.existsSync(loggerFile)) continue;
    let code = fs.readFileSync(loggerFile, "utf-8");

    // 跳过已打补丁（避免重复替换）
    if (code.includes("__DAILYHOT_PATCHED_INJECTOR__")) {
      console.log(`ℹ️ [2/2] ${path.relative(pkgRoot, loggerFile)} 已打过注入式补丁，跳过`);
      patchedLogger = true;
      break;
    }

    const before = code;

    // 注入式拦截器代码（以字符串形式插入 logger.js）
    const INJECTOR = `
/* __DAILYHOT_PATCHED_INJECTOR__ START (Vercel 只读文件系统通用拦截器) */
(() => {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const safeTmp = (os && os.tmpdir && os.tmpdir()) || '/tmp';
    try { if (safeTmp && !fs.existsSync(safeTmp)) fs.mkdirSync(safeTmp, { recursive: true }); } catch (_) {}
    const safeLogDir = path.join(safeTmp, 'logs');
    try { if (!fs.existsSync(safeLogDir)) fs.mkdirSync(safeLogDir, { recursive: true }); } catch (_) {}

    // 1) fs.createWriteStream 拦截：路径不在 /tmp 下一律指向 /tmp/logs/<basename>
    const origCreateWriteStream = fs.createWriteStream.bind(fs);
    function safePath(p) {
      if (!p) return p;
      const s = String(p);
      const norm = s.split(path.sep).join('/');
      const safeN = String(safeTmp).split(path.sep).join('/');
      if (norm === safeN || norm.indexOf(safeN + '/') === 0 || norm.startsWith('file://')) return p;
      const base = path.basename(s) || 'fallback.log';
      return path.join(safeLogDir, base);
    }
    fs.createWriteStream = function (p, opts) {
      try { return origCreateWriteStream(safePath(p), opts); } catch (_) {
        try { return origCreateWriteStream(path.join(safeLogDir, 'fallback.log'), opts); } catch (_2) { return null; }
      }
    };

    // 2) Mock Transport：实现 winston 要求的最小契约（有 log 方法 + 基本 EventEmitter API）
    function makeMockTransport(name) {
      const noop = () => {};
      const mock = {
        silent: true, level: 'info', format: null,
        log(info, cb) { try { if (typeof cb === 'function') cb(null, true); } catch (_) {} return true; },
        on() { return mock; },
        once() { return mock; },
        emit() { return true; },
        addListener() { return mock; },
        removeListener() { return mock; },
        removeAllListeners() { return mock; },
        setMaxListeners() { return mock; },
        end() { noop(); },
        close() { noop(); },
        destroy() { noop(); },
      };
      return mock;
    }

    // 3) 全局 Hook Module._resolveFilename：winston 首次被 require 之后立刻 wrap transports
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    function wrapWinstonTransportsOnce() {
      try {
        const keys = Object.keys(require.cache);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const norm = k.split(path.sep).join('/');
          if (!/winston\/(lib\/)?winston\.js|winston[\\/]index\.js/.test(norm)) continue;
          const cached = require.cache[k] && require.cache[k].exports;
          const w = (cached && (cached.default || cached)) || cached;
          if (!w || !w.transports || w.__dailyhot_wrapped_all__) continue;
          const tp = w.transports;
          Object.keys(tp).forEach(function (tk) {
            const orig = tp[tk];
            if (typeof orig !== 'function' || orig.__dailyhot_wrapped__) return;
            function Wrapped(...args) {
              try { return new orig(...args); } catch (e) {
                try { if (console && console.warn) console.warn('[dailyhot-api logger] transport.' + tk + ' new() 失败，降级 Mock：', String(e && e.message || e).slice(0, 80)); } catch (_) {}
                return makeMockTransport(tk);
              }
            }
            Wrapped.prototype = orig.prototype || {};
            Wrapped.__dailyhot_wrapped__ = true;
            tp[tk] = Wrapped;
          });
          w.__dailyhot_wrapped_all__ = true;
        }
      } catch (_) {}
    }
    Module._resolveFilename = function (request, parent, isMain, options) {
      const filename = origResolve.call(this, request, parent, isMain, options);
      try {
        if (filename && typeof filename === 'string') {
          const norm = filename.split(path.sep).join('/');
          if (/winston\/(lib\/)?winston\.js/.test(norm)) {
            process.nextTick(wrapWinstonTransportsOnce);
            setImmediate(wrapWinstonTransportsOnce);
          }
        }
      } catch (_) {}
      return filename;
    };
    // 保险：拦截器运行时再尝试主动 require('winston') wrap 一次
    try {
      const w = require('winston');
      if (w && w.transports) {
        const tp = w.transports;
        Object.keys(tp).forEach(function (tk) {
          const orig = tp[tk];
          if (typeof orig !== 'function' || orig.__dailyhot_wrapped__) return;
          function Wrapped(...args) {
            try { return new orig(...args); } catch (_e) { return makeMockTransport(tk); }
          }
          Wrapped.prototype = orig.prototype || {};
          Wrapped.__dailyhot_wrapped__ = true;
          tp[tk] = Wrapped;
        });
      }
    } catch (_) {}
  } catch (_) { /* 拦截器自身任何异常一律吞掉，不能影响业务 logger 初始化 */ }
})();
/* __DAILYHOT_PATCHED_INJECTOR__ END */
`;

    // 找插入位置：所有 import 语句之后
    const importRe = /^import\s+(?:[^;\n]+?)\s+from\s+["'`][^"'`]+["'`]\s*;?\s*$|^import\s*["'`][^"'`]+["'`]\s*;?\s*$/gm;
    let insertAt = 0;
    let m;
    while ((m = importRe.exec(code)) !== null) insertAt = m.index + m[0].length;
    const newCode = insertAt > 0
      ? code.slice(0, insertAt) + "\n" + INJECTOR + "\n" + code.slice(insertAt)
      : INJECTOR + "\n" + code;

    // 保底再替换字面量 'logs' / "./logs"（拦截器没生效时的最后防线）
    let code2 = newCode;
    try {
      code2 = code2.replace(
        /(['"`])\.\/logs\1/g,
        (q) => "(require('path').join(require('os').tmpdir() || '/tmp', 'logs'))"
      );
    } catch (_) {}

    if (code2 !== before) {
      fs.writeFileSync(loggerFile, code2, "utf-8");
      console.log(`✅ [2/2] 已注入通用拦截器 ${path.relative(pkgRoot, loggerFile)}（任何 new transports.X 失败 -> Mock，永不抛 Invalid transport）`);
      patchedLogger = true;
      break;
    }
  }
  if (!patchedLogger) {
    console.log("ℹ️ [2/2] 未找到 logger.js 或无需修改，跳过 logger 补丁");
  }
} catch (e) {
  if (e.code === "MODULE_NOT_FOUND") {
    console.log("ℹ️ dailyhot-api 尚未安装（install 阶段会补装），跳过补丁");
  } else {
    console.error("⚠️ 打补丁时出错（不影响构建，继续）：", e.message, e.stack || "");
  }
}
