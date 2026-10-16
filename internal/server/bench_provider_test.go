// bench_provider_test.go 聚合模式端到端压测：完整 HTTP 栈
// （鉴权 → 前缀路由 → provider.ChatStream → SSE 透传）在并发下的吞吐。
// 假上游恒定 200，压的是网关自身开销而非网络。
package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/linguo2625469/workbuddy2api-panel/internal/keyring"
	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/provider"
)

const benchUpstreamSSE = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n" +
	"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"

func benchProviderHandler(b *testing.B) (*Handler, string) {
	b.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, benchUpstreamSSE)
	}))
	b.Cleanup(srv.Close)
	reg := newBenchRegistry(srv.URL)
	h := NewHandler(Config{
		Pool:      pool.New(""),
		KeyRing:   keyring.New([]keyring.Entry{{Key: "sk-user-1", Name: "alice"}}),
		Providers: reg,
	})
	return h, srv.URL
}

// newBenchRegistry 经 JSON 反序列化构造：走 Entry/Provider 的 UnmarshalJSON，
// enabled 缺省 true 生效（代码直构必须显式 Enabled:true，这里对齐生产配置路径）。
func newBenchRegistry(baseURL string) *provider.Registry {
	raw := []byte(`[{"name":"artex","base_url":"` + baseURL + `","models":["m"],` +
		`"keys":[{"key":"k1"},{"key":"k2"}]}]`)
	var providers []provider.Provider
	if err := json.Unmarshal(raw, &providers); err != nil {
		panic(err)
	}
	return provider.NewRegistry(providers, nil)
}

// BenchmarkProviderChatE2E N 并发打 /v1/chat/completions（artex: 前缀路由）。
// 请求体复用，响应流读尽后关闭（对齐真实客户端行为，避免连接泄漏放大）。
func BenchmarkProviderChatE2E(b *testing.B) {
	h, _ := benchProviderHandler(b)
	body := `{"model":"artex:m","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer sk-user-1")
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				b.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
			}
		}
	})
}

// TestConcurrentProviderFlood 洪峰 smoke：200 goroutine × 20 请求同时打进
// 聚合路由，全部应 200 且 SSE 完整（无截断/串流）。-race 下由 CI 补。
func TestConcurrentProviderFlood(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, benchUpstreamSSE)
	}))
	defer srv.Close()
	reg := newBenchRegistry(srv.URL)
	h := NewHandler(Config{
		Pool:      pool.New(""),
		KeyRing:   keyring.New([]keyring.Entry{{Key: "sk-user-1", Name: "alice"}}),
		Providers: reg,
	})

	const workers, perWorker = 200, 20
	var wg sync.WaitGroup
	errs := make(chan string, workers)
	for w0 := 0; w0 < workers; w0++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest("POST", "/v1/chat/completions",
					strings.NewReader(`{"model":"artex:m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
				req.Header.Set("Authorization", "Bearer sk-user-1")
				h.ServeHTTP(rec, req)
				if rec.Code != http.StatusOK {
					errs <- fmt.Sprintf("code=%d body=%s", rec.Code, rec.Body.String())
					return
				}
				if !strings.Contains(rec.Body.String(), "[DONE]") {
					errs <- "stream truncated: " + rec.Body.String()
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
}
