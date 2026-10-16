// bench_test.go 供应商注册表并发压测。
//
// 压测目标：
//   - pick 轮转在多 goroutine 竞争同一 Registry 时是否线程安全且分布均匀；
//   - ChatStream 全链路（pick → prepareBody → HTTP → SSE 读尽 → noteSuccess）
//     在 N 并发下的吞吐；
//   - Store 热更新与并发读（Has/ChatStream）交织时不panic（无 race detector
//     环境下的 smoke——go test -race 由 CI 补）。
package provider

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// benchSSE 一秒可读完的最小 SSE 流。
const benchSSE = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n" +
	"data: {\"choices\":[],\"usage\":{\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"

// benchRegistry K 槽位供应商指向恒定 200 的假上游。
func benchRegistry(b *testing.B, slots int) *Registry {
	b.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, benchSSE)
	}))
	b.Cleanup(srv.Close)
	keys := make([]Entry, slots)
	for i := range keys {
		keys[i] = Entry{Key: fmt.Sprintf("sk-%d", i), Enabled: true}
	}
	return NewRegistry([]Provider{{
		Name: "bench", BaseURL: srv.URL, Keys: keys,
		Models: []string{"m"}, Enabled: true,
	}}, nil)
}

// BenchmarkChatStream 并发全链路压测（b.N 次调用，并行度 = GOMAXPROCS）。
func BenchmarkChatStream(b *testing.B) {
	for _, slots := range []int{1, 4, 16} {
		b.Run(fmt.Sprintf("slots=%d", slots), func(b *testing.B) {
			reg := benchRegistry(b, slots)
			body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					res, _ := reg.ChatStream(context.Background(), "bench", "m", body)
					if res.Err != nil {
						b.Fatal(res.Err)
					}
					if res.RC != nil {
						io.Copy(io.Discard, res.RC)
						res.RC.Close()
					}
				}
			})
		})
	}
}

// BenchmarkPick 纯槽位轮转竞争（不打网络，量化锁竞争下界）。
func BenchmarkPick(b *testing.B) {
	reg := NewRegistry([]Provider{{
		Name: "x", BaseURL: "http://127.0.0.1:1", Enabled: true,
		Keys: []Entry{{Key: "a", Enabled: true}, {Key: "b", Enabled: true}},
	}}, nil)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			reg.mu.Lock()
			reg.byName["x"].pick()
			reg.mu.Unlock()
		}
	})
}

// TestConcurrentStoreAndChat 热更新（Store）与并发 ChatStream/Has 交织：
// 300 次全量替换 × 32 并发读，任何 data race 在 -race 下会立刻显形；
// 无 -race 时至少保证不 panic、不死锁、请求全部有终态。
func TestConcurrentStoreAndChat(t *testing.T) {
	reg := benchRegistry(&testing.B{}, 2) // 借用构造；testing.B 仅作 Helper 载体
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if !reg.Has("bench") {
					t.Error("Has=false during Store")
					return
				}
				res, _ := reg.ChatStream(context.Background(), "bench", "m", body)
				if res.RC != nil {
					io.Copy(io.Discard, res.RC)
					res.RC.Close()
				}
			}
		}()
	}
	base := reg.byName["bench"].baseURL
	for i := 0; i < 300; i++ {
		reg.Store([]Provider{{
			Name: "bench", BaseURL: base, Enabled: true,
			Keys:   []Entry{{Key: fmt.Sprintf("rot-%d", i), Enabled: true}},
			Models: []string{"m"},
		}})
	}
	close(stop)
	wg.Wait()
}
