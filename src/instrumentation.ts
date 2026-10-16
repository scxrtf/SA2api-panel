// instrumentation.ts — Next.js 进程启动钩子（Node runtime）。
// 在首个请求处理前调用 register()：启动进程内调度器（签到/旅行/活跃/保活/夜猫子/
// 成长队列 + 余额刷新）。Edge runtime 不启动（本项目全部 route 均为 nodejs runtime）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
