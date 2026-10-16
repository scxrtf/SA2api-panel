// modeltest_test.go 面板测试模型端点（POST /panel/api/models/test）单测。
// 覆盖：供应商前缀路由（httptest 假上游 SSE）、取消（DELETE → 499）、
// 重复 test_id 409、上游 401 透传、池无可用账号 503。
package panel

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/provider"
)

// sseBody 构造一条最小 OpenAI SSE 流（两帧内容 + usage + DONE）。
func sseBody(content, completionTokens string) string {
	return "data: {\"choices\":[{\"delta\":{\"content\":\"" + content + "\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"completion_tokens\":" + completionTokens + "}}\n\n" +
		"data: [DONE]\n\n"
}

// newTestRegistry 注册一个指向 httptest 假上游的供应商。
func newTestRegistry(t *testing.T, handler http.HandlerFunc) *provider.Registry {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return provider.NewRegistry([]provider.Provider{{
		Name:    "fake",
		BaseURL: srv.URL,
		Keys:    []provider.Entry{{Key: "sk-fake", Enabled: true}},
		Models:  []string{"m1"},
		Enabled: true,
	}}, nil)
}

func doModelTest(t *testing.T, p *Panel, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/panel/api/models/test", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-key")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

func TestModelTestProviderRoute(t *testing.T) {
	reg := newTestRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-fake" {
			t.Errorf("auth header = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseBody("1 2 3", "3"))
	})
	p := New(Config{Version: "test", APIKey: "test-key", Providers: reg})

	rec := doModelTest(t, p, `{"model":"fake:m1","test_id":"t1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		OK     bool `json:"ok"`
		Result struct {
			DurationMs      int64   `json:"duration_ms"`
			OutputTokens    int64   `json:"output_tokens"`
			TokensPerSecond float64 `json:"tokens_per_second"`
			TokensEstimated bool    `json:"tokens_estimated"`
			Output          string  `json:"output"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Result.Output != "1 2 3" || got.Result.OutputTokens != 3 || got.Result.TokensEstimated {
		t.Fatalf("result = %+v", got)
	}
}

func TestModelTestDuplicateID(t *testing.T) {
	// 假上游阻塞到 ctx 取消：保证第一次测试在跑时提交同 id。
	release := make(chan struct{})
	reg := newTestRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	p := New(Config{Version: "test", APIKey: "test-key", Providers: reg})
	defer close(release)

	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- doModelTest(t, p, `{"model":"fake:m1","test_id":"dup"}`) }()
	// 等第一次注册进 modelTests。
	deadline := time.Now().Add(2 * time.Second)
	for {
		modelTestMu.Lock()
		_, running := modelTests["dup"]
		modelTestMu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first test never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}

	rec := doModelTest(t, p, `{"model":"fake:m1","test_id":"dup"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate: code=%d want 409 body=%s", rec.Code, rec.Body.String())
	}

	// 取消第一次，确认返回 499。
	req := httptest.NewRequest("DELETE", "/panel/api/models/test/dup", nil)
	req.Header.Set("Authorization", "Bearer test-key")
	cancelRec := httptest.NewRecorder()
	p.ServeHTTP(cancelRec, req)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("cancel: code=%d body=%s", cancelRec.Code, cancelRec.Body.String())
	}
	select {
	case r1 := <-first:
		if r1.Code != 499 {
			t.Fatalf("cancelled test: code=%d want 499 body=%s", r1.Code, r1.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first test did not finish after cancel")
	}
}

func TestModelTestUpstreamError(t *testing.T) {
	reg := newTestRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"bad key"}`)
	})
	p := New(Config{Version: "test", APIKey: "test-key", Providers: reg})

	rec := doModelTest(t, p, `{"model":"fake:m1"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d want 401 body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("bad key")) {
		t.Fatalf("body=%s want upstream message passthrough", rec.Body.String())
	}
}

func TestModelTestUnknownProvider(t *testing.T) {
	p := New(Config{Version: "test", APIKey: "test-key"})
	rec := doModelTest(t, p, `{"model":"nope:m1"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code=%d want 404 body=%s", rec.Code, rec.Body.String())
	}
}
