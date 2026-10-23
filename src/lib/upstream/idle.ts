// idle.ts 聊天 SSE 流空闲看门狗（移植 internal/upstream/idle.go）：
// 活跃吐数据续命不掐，静默超过阈值才断流（掐流释放账号租约，防止僵死连接占坑）。
// 计时从包裹之后开始——首字节阶段由 fetch 自身的连接超时管，这里不抢跑。

// idleTick 监控周期：idle/4，钳在 [10ms, 1s]。小 idle 快速发现，大值避免空转。
export function idleTick(idleMs: number): number {
  let d = Math.floor(idleMs / 4);
  if (d > 1000) d = 1000;
  if (d < 10) d = 10;
  return d;
}

// idleMonitorBody 若 idleMs<=0 原样返回底流（禁用监控）；
// 否则包一层：每次读到底层 chunk 刷新 lastRead，后台周期检查，
// 静默超过 idleMs 就 cancel 底流（下游消费侧拿到 reader.read() 终止即收尾）。
// 下游读取结束（cancel/自然 EOF）时 stop() 停掉后台计时器，保证无泄漏。
export function idleMonitorBody(body: ReadableStream<Uint8Array>, idleMs: number, onTimeout?: () => void): ReadableStream<Uint8Array> {
  if (idleMs <= 0) return body;
  let lastRead = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const reader = body.getReader();
  const startWatch = () => {
    timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() - lastRead > idleMs) {
        stopWatch();
        onTimeout?.();
        // 掐流：cancel 上游 reader，阻塞中的下游 read() 拿到 done 收尾。
        void reader.cancel("stream idle timeout").catch(() => undefined);
      }
    }, idleTick(idleMs));
    // 不占事件循环引用（Node 下防止 timer 阻止进程退出；浏览器无害）。
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  };
  const stopWatch = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };
  return new ReadableStream<Uint8Array>({
    start() {
      startWatch();
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (e) {
        stopWatch();
        controller.error(e);
        return;
      }
      const { done, value } = result;
      if (done) {
        stopWatch();
        controller.close();
        return;
      }
      if (value && value.byteLength > 0) lastRead = Date.now();
      controller.enqueue(value);
    },
    async cancel(reason) {
      stopWatch();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
