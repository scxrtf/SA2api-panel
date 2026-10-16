// bench_test.go keyring 并发压测：Identify（常量时间比较）与 Store 热更新
// 在多读单写交织下的安全性；压测用 -race 跑由 CI 补，本地量化锁竞争下界。
package keyring

import (
	"fmt"
	"sync"
	"testing"
)

func benchRing(n int) *Ring {
	entries := make([]Entry, n)
	for i := range entries {
		entries[i] = Entry{Key: fmt.Sprintf("sk-load-%06d-secretpadding", i), Name: fmt.Sprintf("u%d", i), Enabled: true}
	}
	return New(entries)
}

// BenchmarkIdentify 命中/未命中两条路径：命中走到最后一把 key（最坏情形），
// 未命中全表扫描。Identify 是常量时间实现，N 把 key 的扫描成本线性增长，
// 该基准量化「多 key 会不会拖慢鉴权」。
func BenchmarkIdentify(b *testing.B) {
	for _, n := range []int{8, 64, 256} {
		ring := benchRing(n)
		hit := fmt.Sprintf("sk-load-%06d-secretpadding", n-1) // 最后一把：全扫描
		b.Run(fmt.Sprintf("hit/n=%d", n), func(b *testing.B) {
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					if ring.Identify(hit) == "" {
						b.Fatal("miss")
					}
				}
			})
		})
		b.Run(fmt.Sprintf("miss/n=%d", n), func(b *testing.B) {
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					ring.Identify("sk-no-such-key")
				}
			})
		})
	}
}

// TestConcurrentStoreAndIdentify 配置热保存（Store）与并发鉴权交织：
// Identify 任何时刻要么命中旧表要么命中新表，不得返回部分状态或 panic。
func TestConcurrentStoreAndIdentify(t *testing.T) {
	ring := benchRing(64)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				ring.Identify("sk-load-000063-secretpadding")
				_ = ring.Keys()
				_ = ring.Empty()
			}
		}()
	}
	for i := 0; i < 500; i++ {
		ring.Store([]Entry{{Key: fmt.Sprintf("rot-%d", i), Name: "r", Enabled: true}})
	}
	close(stop)
	wg.Wait()
	if ring.Identify("rot-499") != "r" {
		t.Fatal("final Store not visible")
	}
}
