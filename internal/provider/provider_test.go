package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNormalizedBase(t *testing.T) {
	cases := map[string]string{
		"https://api.openai.com":      "https://api.openai.com",
		"https://api.openai.com/":     "https://api.openai.com",
		"https://api.openai.com/v1":   "https://api.openai.com",
		"https://api.openai.com/v1/":  "https://api.openai.com",
		" https://x.dev/v1 ":          "https://x.dev",
		"https://x.dev/api/v2":        "https://x.dev/api/v2",
	}
	for in, want := range cases {
		if got := normalizedBase(in); got != want {
			t.Fatalf("normalizedBase(%q)=%q want %q", in, got, want)
		}
	}
}

func TestPrepareBody(t *testing.T) {
	src := []byte(`{"model":"cn:gpt","messages":[{"role":"user","content":"hi"}],"stream":false,"temperature":0.7}`)
	out := prepareBody(src, "gpt-4o")
	var obj map[string]any
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatal(err)
	}
	if obj["model"] != "gpt-4o" {
		t.Fatalf("model=%v", obj["model"])
	}
	if obj["stream"] != true {
		t.Fatalf("stream=%v", obj["stream"])
	}
	so, ok := obj["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Fatalf("stream_options=%v", obj["stream_options"])
	}
	if obj["temperature"] != 0.7 {
		t.Fatalf("temperature must pass through: %v", obj["temperature"])
	}
}

func TestPrepareBodyKeepsExistingStreamOptions(t *testing.T) {
	src := []byte(`{"model":"m","stream_options":{"include_usage":false,"extra":1}}`)
	out := prepareBody(src, "m")
	var obj map[string]any
	_ = json.Unmarshal(out, &obj)
	so := obj["stream_options"].(map[string]any)
	if so["extra"] != float64(1) {
		t.Fatalf("existing stream_options must not be overwritten: %v", so)
	}
}

func TestRegistryStoreAndHas(t *testing.T) {
	r := NewRegistry([]Provider{
		// 代码构造路径必须显式 Enabled:true（JSON 反序列化才走缺省 true）。
		{Name: "artex", BaseURL: "https://a.example", Key: "sk-1", Enabled: true},
		{Name: "disabled", BaseURL: "https://d.example", Key: "sk-2", Enabled: false},
		{Name: "nokey", BaseURL: "https://n.example", Enabled: true},
	}, nil)
	if !r.Has("artex") {
		t.Fatal("artex must be registered")
	}
	if r.Has("disabled") {
		t.Fatal("disabled provider must not register")
	}
	if r.Has("nokey") {
		t.Fatal("provider without any key must not register")
	}
	if r.Has("missing") {
		t.Fatal("unknown provider")
	}
	r.Store(nil)
	if r.Has("artex") {
		t.Fatal("Store(nil) must clear")
	}
}

func TestRegistryStaticModels(t *testing.T) {
	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: "https://a.example", Key: "sk-1", Models: []string{"m1", "m2"}, Enabled: true},
	}, nil)
	models := r.Models(context.Background(), "p")
	if len(models) != 2 || models[0] != "m1" {
		t.Fatalf("models=%v", models)
	}
	if got := r.Models(context.Background(), "unknown"); got != nil {
		t.Fatalf("unknown provider models=%v", got)
	}
}

func TestRegistryChatStreamSuccess(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()

	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: srv.URL + "/v1", Key: "sk-test", Enabled: true},
	}, nil)
	res, _ := r.ChatStream(context.Background(), "p", "m", []byte(`{"messages":[]}`))
	if res.Err != nil {
		t.Fatalf("err=%v", res.Err)
	}
	if res.Status != 200 || res.RC == nil {
		t.Fatalf("res=%+v", res)
	}
	body, _ := io.ReadAll(res.RC)
	res.RC.Close()
	if !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("body=%q", body)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth=%q", gotAuth)
	}
	if !strings.Contains(gotBody, `"stream":true`) {
		t.Fatalf("upstream body must force stream: %s", gotBody)
	}
	if res.Slot == "" {
		t.Fatal("slot name must be recorded")
	}
}

func TestRegistryChatStreamHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"error":{"message":"bad key"}}`)
	}))
	defer srv.Close()

	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: srv.URL, Key: "sk-bad", Enabled: true},
	}, nil)
	res, cooldown := r.ChatStream(context.Background(), "p", "m", []byte(`{}`))
	if res.Err != nil {
		t.Fatalf("err=%v", res.Err)
	}
	if res.Status != 401 {
		t.Fatalf("status=%d", res.Status)
	}
	if !strings.Contains(string(res.RespBody), "bad key") {
		t.Fatalf("body=%q", res.RespBody)
	}
	if !cooldown {
		t.Fatal("401 must feed the breaker (key itself invalid)")
	}
}

func TestRegistryChatStream400NotPenalized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: srv.URL, Key: "sk-x", Enabled: true},
	}, nil)
	_, cooldown := r.ChatStream(context.Background(), "p", "m", []byte(`{}`))
	if cooldown {
		t.Fatal("400 is a request problem, must not feed the breaker")
	}
}

func TestRegistrySlotBreaker(t *testing.T) {
	var calls int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: srv.URL, Enabled: true, Keys: []Entry{
			{Key: "sk-1", Enabled: true}, {Key: "sk-2", Enabled: true},
		}},
	}, nil)
	// 连败 3 次后该槽位熔断 5min；双槽位轮转保证请求仍能打到另一个槽位。
	for i := 0; i < 6; i++ {
		r.ChatStream(context.Background(), "p", "m", []byte(`{}`))
	}
	if atomic.LoadInt64(&calls) != 6 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestRegistryModelsRemoteProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":[{"id":"a"},{"id":"b"}]}`)
	}))
	defer srv.Close()

	r := NewRegistry([]Provider{
		{Name: "p", BaseURL: srv.URL, Key: "sk-1", Enabled: true},
	}, nil)
	models := r.Models(context.Background(), "p")
	if len(models) != 2 || models[0] != "a" {
		t.Fatalf("models=%v", models)
	}
	// 二次调用走缓存（服务端即使挂了也返回缓存）。
	srv.Close()
	models = r.Models(context.Background(), "p")
	if len(models) != 2 {
		t.Fatalf("cached models=%v", models)
	}
}
