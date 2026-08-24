/**
 * 本地开发/测试启动脚本（不用于 Vercel）
 * 用法： node start.js   或   npm start
 * 作用：用原生 http.createServer 加载我们的 handler()，
 *       在 http://localhost:3000 提供和 Vercel 一致的接口行为。
 */
import http from "http";
import handler from "./index.js";

const PORT = parseInt(process.env.PORT, 10) || 3000;

const server = http.createServer(async (req, res) => {
  try {
    await handler(req, res);
    // 极端兜底：如果 handler 内部未调用 res.end()，强制结束
    // （正常情况下 index.js 内三层 try/catch 都保证 end）
    if (!res.writableEnded) {
      console.warn("⚠️ handler 未结束响应，本地脚本强制 res.end()");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      res.end(
        JSON.stringify({
          code: 500,
          message: "Handler 未产生响应（本地服务器兜底）",
        })
      );
    }
  } catch (e) {
    console.error("❌ [start.js top-error]", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(
      JSON.stringify({
        code: 500,
        message: "本地服务器顶层错误",
        error: e?.message || String(e),
      })
    );
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("✅ 本地服务器启动成功");
  console.log(`📍 本地地址:  http://localhost:${PORT}`);
  console.log("");
  console.log("📋 快速测试：");
  console.log(`   - Reddit:       http://localhost:${PORT}/reddit`);
  console.log(`   - HackerNews:   http://localhost:${PORT}/hackernews`);
  console.log(`   - Bilibili:     http://localhost:${PORT}/bilibili`);
  console.log(`   - Weibo:        http://localhost:${PORT}/weibo`);
  console.log(`   - 全部路由:     http://localhost:${PORT}/all`);
  console.log("========================================");
  console.log("");
  console.log("按 Ctrl+C 停止服务器");
});
