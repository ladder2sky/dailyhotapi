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
  // 修复 2（兜底）：不碰 dailyhot-api 任何源码的 JS 内容（零语法错误风险）
  //   ⚠️ 2026-08-24 最终方案：
  //     真正的 winston 拦截 100% 放在 index.js 顶层 0 号防线（运行时 monkey-patch），
  //     构建补丁 patch-dailyhot-api.js 这里只做一件零风险的事：
  //       - 尝试把 dailyhot-api 自己包目录里的 logs 文件夹软链/复制到 /tmp（如果可写）
  //       - 以及（最重要）把 dist/utils/logger.js 里所有 `./logs`、`logs` 字面量替换成 `/tmp/logs`
  //       - 不插入任何新 JS 代码，只做简单字符串替换，不会改变 AST/语法
  // ============================================================
  const loggerPaths = [
    path.join(pkgRoot, "dist", "utils", "logger.js"),
    path.join(pkgRoot, "src", "utils", "logger.js"),
  ];
  let patchedLogger = false;
  for (const loggerFile of loggerPaths) {
    if (!fs.existsSync(loggerFile)) continue;
    let code = fs.readFileSync(loggerFile, "utf-8");
    if (code.includes("__DAILYHOT_LOG_PATCHED_LITERAL__")) {
      console.log(`ℹ️ [2/2] ${path.relative(pkgRoot, loggerFile)} 已替换 logs 字面量，跳过`);
      patchedLogger = true;
      break;
    }
    const before = code;
    // 仅做最保守的字面量替换（硬编码 /tmp/logs 最安全，不会用到任何未定义变量）
    // `./logs` 或 `logs` 但不包含 `/logs`（避免误伤 http://foo/logs）
    code = code.replace(/(['"`])(\.\/)?logs\1/g, (_m, q) => `${q}/tmp/logs${q} /* __DAILYHOT_LOG_PATCHED_LITERAL__ */`);
    // dirname: 'logs'（对象里单独的字段，字符串不包含路径的）
    code = code.replace(/(\bdirname\s*:\s*)(['"`])logs\2/g, (_m, pre, q) => `${pre}${q}/tmp/logs${q} /* __DAILYHOT_LOG_PATCHED_LITERAL__ */`);
    if (code !== before) {
      fs.writeFileSync(loggerFile, code, "utf-8");
      console.log(`✅ [2/2] ${path.relative(pkgRoot, loggerFile)} logs 字面量已替换为 /tmp/logs（仅纯字面量替换，未插入任何新语句）`);
      patchedLogger = true;
      break;
    }
  }
  if (!patchedLogger) {
    console.log("ℹ️ [2/2] 未找到 logger.js 或字面量无需替换，跳过（index.js 顶层 0 号防线仍会生效）");
  }
} catch (e) {
  if (e.code === "MODULE_NOT_FOUND") {
    console.log("ℹ️ dailyhot-api 尚未安装（install 阶段会补装），跳过补丁");
  } else {
    console.error("⚠️ 打补丁时出错（不影响构建，继续）：", e.message, e.stack || "");
  }
}
