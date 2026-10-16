// Package provider 通用 OpenAI 兼容上游供应商（聚合网关的第二类上游）。
//
// 与 internal/upstream 的分工：
//   - upstream：CodeBuddy 专用通道（OAuth 账号池、计费、签到、错误分类状态机）；
//   - 本包：任意「base_url + api_key」的 OpenAI 兼容服务（Artex 等聚合站、
//     OpenAI/DeepSeek/百炼官方端点），逐 key 直连，无账号池概念。
//
// 复用点：transport 不复制——直接共享 upstream.Client 的加固 Transport（禁 h2 /
// 握手超时 / keepalive 探测）；SSE 聚合/透传完全复用 upstream.Aggregate /
// upstream.StreamHint（请求体不做 CodeBuddy 专属改写，仅按需强制 stream:true
// 与补 stream_options，保证下游拿到 usage 帧）。
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/logfmt"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

// Entry 一个供应商 key 槽位（config providers[].keys[] 或单 key 简写展开）。
type Entry struct {
	Name    string   `json:"name,omitempty"`     // 槽位名（展示/统计归属用）；空 = "key-N"
	Key     string   `json:"key"`                // 供应商 API key 原文
	BaseURL string   `json:"base_url,omitempty"` // 覆盖供应商级 base_url（同供应商多区域部署）
	Models  []string `json:"models,omitempty"`   // 覆盖供应商级模型名单
	Enabled bool     `json:"enabled"`            // false = 停用该槽位（缺省 true，见 UnmarshalJSON）
}

// UnmarshalJSON 实现 enabled 缺省 true：键缺席 → true，显式 false → false。
// 注意：该缺省语义只对 JSON 路径生效；代码构造 Entry 必须显式给 Enabled 赋值。
func (e *Entry) UnmarshalJSON(raw []byte) error {
	// *bool 三态：nil=缺席→true；显式 true/false 照收。
	var a struct {
		Name    string   `json:"name"`
		Key     string   `json:"key"`
		BaseURL string   `json:"base_url"`
		Models  []string `json:"models"`
		Enabled *bool    `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return err
	}
	e.Name = a.Name
	e.Key = a.Key
	e.BaseURL = a.BaseURL
	e.Models = a.Models
	e.Enabled = a.Enabled == nil || *a.Enabled
	return nil
}

// Provider 一个 OpenAI 兼容供应商。
type Provider struct {
	Name    string   `json:"name"`    // 路由前缀（model 名 "供应商:模型"）；必填，唯一
	BaseURL string   `json:"base_url"` // 如 https://api.openai.com（/v1 可带可不带，见 normalizedBase）
	Key     string   `json:"key,omitempty"`   // 单 key 简写（与 keys 并存时并入 keys）
	Keys    []Entry  `json:"keys,omitempty"`  // 多 key 槽位（聚合站多额度号场景）
	Models  []string `json:"models,omitempty"` // 静态模型名单；空 = 启动时拉 /v1/models 探测
	Enabled bool `json:"enabled"` // false = 整供应商停用（缺省 true）
}

// UnmarshalJSON 实现 enabled 缺省 true（同 Entry 的 *bool 三态）。
func (p *Provider) UnmarshalJSON(raw []byte) error {
	var a struct {
		Name    string   `json:"name"`
		BaseURL string   `json:"base_url"`
		Key     string   `json:"key"`
		Keys    []Entry  `json:"keys"`
		Models  []string `json:"models"`
		Enabled *bool    `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return err
	}
	p.Name = a.Name
	p.BaseURL = a.BaseURL
	p.Key = a.Key
	p.Keys = a.Keys
	p.Models = a.Models
	p.Enabled = a.Enabled == nil || *a.Enabled
	return nil
}

// ---------------------------------------------------------------------------
// Registry 供应商注册表（装配期构建，运行期整体替换）。
// ---------------------------------------------------------------------------

// slot 运行态 key 槽位：归属名 + 熔断状态。
type slot struct {
	name    string
	key     string
	baseURL string
	models  []string
	// failures/cooldownUntil 连败熔断：连续失败 threshold 次 → 冷却至 until。
	failures      int
	cooldownUntil time.Time
}

// providerState 运行态供应商。
type providerState struct {
	name      string
	baseURL   string
	models    []string // 静态名单（可为空，空时走远端探测）
	slots     []*slot
	rr        int // 槽位轮转游标
}

// Registry 并发安全供应商注册表。
type Registry struct {
	mu     sync.RWMutex
	byName map[string]*providerState

	http    *http.Client // 短 RPC（models 探测）
	chat    *http.Client // SSE 长流（无总时长）
	idle    time.Duration
	timeout time.Duration

	// 远端模型探测缓存（探测失败负缓存，避免每次 /v1/models 都回源）。
	modelsMu    sync.Mutex
	modelsCache map[string]modelsProbe
}

type modelsProbe struct {
	ids      []string
	fetched  time.Time
	lastFail time.Time
}

const (
	// breakerThreshold 槽位连续失败熔断阈值；breakerCooldown 冷却时长。
	// 比 CodeBuddy 池简单：供应商侧没有账号生命周期，连败即冷却，冷却到自动恢复。
	breakerThreshold = 3
	breakerCooldown  = 5 * time.Minute

	modelsTTL        = 10 * time.Minute
	modelsFailCool   = 5 * time.Minute
)

// NewRegistry 构建注册表。chat 复用 upstream.Client 的 ChatHTTP（共享加固
// Transport）；timeout/idle 与 upstream 同配置来源。
func NewRegistry(providers []Provider, up *upstream.Client) *Registry {
	r := &Registry{
		byName:      map[string]*providerState{},
		modelsCache: map[string]modelsProbe{},
		timeout:     120 * time.Second,
		idle:        300 * time.Second,
	}
	if up != nil {
		r.http = up.HTTP
		r.chat = up.ChatHTTP
		if up.IdleTimeout > 0 {
			r.idle = up.IdleTimeout
		}
		if up.HTTP != nil && up.HTTP.Timeout > 0 {
			r.timeout = up.HTTP.Timeout
		}
	}
	if r.http == nil {
		// 裸 client 也要显式 Transport：http.DefaultTransport 的
		// MaxIdleConnsPerHost=2 在 Windows 高并发下会复用半死回环连接
		//（洪峰压测实证：200 goroutine 打 httptest 假上游出现批量
		// connectex refused，显式拨号器 + 20/host 后归零）。
		tr := &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 15 * time.Second}).DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   20,
			IdleConnTimeout:       30 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		}
		r.http = &http.Client{Timeout: r.timeout, Transport: tr}
	}
	if r.chat == nil {
		// chat 复用同一 Transport 形态（连接池不重复是 upstream 侧的设计，
		// 这里两 client 独立 Transport 只在无注入的兜底路径，量级可接受）。
		tr := &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 15 * time.Second}).DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   20,
			IdleConnTimeout:       30 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		}
		r.chat = &http.Client{Transport: tr}
	}
	r.Store(providers)
	return r
}

// Store 整体替换供应商列表（面板保存配置热生效）。
func (r *Registry) Store(providers []Provider) {
	byName := map[string]*providerState{}
	for _, p := range providers {
		if !p.Enabled || p.Name == "" || p.BaseURL == "" {
			continue
		}
		base := normalizedBase(p.BaseURL)
		ps := &providerState{name: p.Name, baseURL: base, models: p.Models}
		entries := append([]Entry{}, p.Keys...)
		if p.Key != "" {
			entries = append(entries, Entry{Key: p.Key, Enabled: true})
		}
		for i, e := range entries {
			if !e.Enabled || e.Key == "" {
				continue
			}
			name := e.Name
			if name == "" {
				name = fmt.Sprintf("key-%d", i+1)
			}
			sb := base
			if e.BaseURL != "" {
				sb = normalizedBase(e.BaseURL)
			}
			models := p.Models
			if len(e.Models) > 0 {
				models = e.Models
			}
			ps.slots = append(ps.slots, &slot{name: name, key: e.Key, baseURL: sb, models: models})
		}
		if len(ps.slots) > 0 {
			byName[p.Name] = ps
		}
	}
	r.mu.Lock()
	r.byName = byName
	r.mu.Unlock()
}

// normalizedBase 归一化 base_url：去尾斜杠、去尾 "/v1"（endpoint 统一拼 "/v1/..."）。
func normalizedBase(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	u = strings.TrimSuffix(u, "/v1")
	return u
}

// Names 返回当前生效的供应商名列表（路由判定/配置校验用）。
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.byName))
	for n := range r.byName {
		out = append(out, n)
	}
	return out
}

// Has 报告 name 是否为生效供应商。
func (r *Registry) Has(name string) bool {
	if r == nil {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.byName[name]
	return ok
}

// pick 选一个可用槽位（轮转 + 跳过冷却中槽位）；全冷却返回最早解封的槽位。
func (ps *providerState) pick() *slot {
	now := time.Now()
	n := len(ps.slots)
	var earliest *slot
	for i := 0; i < n; i++ {
		s := ps.slots[(ps.rr+i)%n]
		if s.cooldownUntil.IsZero() || now.After(s.cooldownUntil) {
			ps.rr = (ps.rr + i + 1) % n
			return s
		}
		if earliest == nil || s.cooldownUntil.Before(earliest.cooldownUntil) {
			earliest = s
		}
	}
	return earliest
}

func (s *slot) noteSuccess() { s.failures = 0 }

func (s *slot) noteFailure() {
	s.failures++
	if s.failures >= breakerThreshold {
		s.cooldownUntil = time.Now().Add(breakerCooldown)
		s.failures = 0
	}
}

// prepareBody 通用改写：强制 stream:true + 补 stream_options（下游需要 usage 帧），
// 不动 CodeBuddy 专属的 tool/thinking/sanitize 管线——那是上游私有协议，普通
// OpenAI 兼容服务不需要，套用了反而会改写合法请求体。
func prepareBody(src []byte, model string) []byte {
	var obj map[string]any
	if err := json.Unmarshal(src, &obj); err != nil {
		return src
	}
	obj["model"] = model
	obj["stream"] = true
	if _, has := obj["stream_options"]; !has {
		obj["stream_options"] = map[string]any{"include_usage": true}
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return src
	}
	return out
}

// ChatResult 一次供应商调用的结果。
type ChatResult struct {
	RC       io.ReadCloser // 成功时的 SSE 流（调用方负责 Close）
	Status   int
	RespBody []byte // 失败时的响应体原文（透传用）
	Err      error  // 传输层错误（Status 无意义）
	Slot     string // 实际命中的槽位名（用量归属）
}

// ChatStream 发起一次供应商 chat 调用（单槽位，无重试——轮转在 server 层做）。
// 错误语义与 upstream.ChatStreamContext 对齐：≥400 返回 (status, body)；
// 传输层错误返回 err。
func (r *Registry) ChatStream(ctx context.Context, provider, model string, body []byte) (res ChatResult, cooldown bool) {
	r.mu.Lock()
	ps := r.byName[provider]
	if ps == nil {
		r.mu.Unlock()
		return ChatResult{Err: fmt.Errorf("provider %q not found", provider)}, false
	}
	s := ps.pick()
	r.mu.Unlock()
	if s == nil {
		return ChatResult{Err: fmt.Errorf("provider %q has no available key slot", provider)}, false
	}
	res.Slot = s.name
	if ctx == nil {
		ctx = context.Background()
	}
	endpoint := s.baseURL + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(prepareBody(body, model)))
	if err != nil {
		return res, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := r.chat.Do(req)
	if err != nil {
		res.Err = err
		s.noteFailure()
		log.Printf("ERR: [provider] chat %s/%s model=%s: transport error: %v", provider, s.name, model, err)
		return res, false
	}
	if resp.StatusCode >= 400 {
		raw, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		res.Status = resp.StatusCode
		res.RespBody = raw
		if rerr != nil {
			res.Err = fmt.Errorf("read body: %w", rerr)
			res.RespBody = nil
		}
		// 429/5xx 喂熔断；401/403 是 key 本身失效也喂（该槽位冷却换下一 key）；
		// 400 是请求问题不罚（换 key 无用）。
		if resp.StatusCode != http.StatusBadRequest {
			s.noteFailure()
			cooldown = true
		}
		log.Printf("WARN: [provider] chat %s/%s model=%s: upstream %d body=%s",
			provider, s.name, model, resp.StatusCode, logfmt.Truncate(string(raw), 200))
		return res, cooldown
	}
	s.noteSuccess()
	res.RC = upstream.MonitorBodyFor(resp.Body, r.idle)
	res.Status = resp.StatusCode
	return res, false
}

// Models 返回供应商模型名单：静态配置优先，否则远端探测（缓存 10min）。
func (r *Registry) Models(ctx context.Context, provider string) []string {
	r.mu.RLock()
	ps := r.byName[provider]
	r.mu.RUnlock()
	if ps == nil {
		return nil
	}
	if len(ps.models) > 0 {
		return append([]string{}, ps.models...)
	}
	// 远端探测：用任一槽位的 key 拉 /v1/models。
	r.modelsMu.Lock()
	probe := r.modelsCache[provider]
	if len(probe.ids) > 0 && time.Since(probe.fetched) < modelsTTL {
		r.modelsMu.Unlock()
		return append([]string{}, probe.ids...)
	}
	if !probe.lastFail.IsZero() && time.Since(probe.lastFail) < modelsFailCool {
		r.modelsMu.Unlock()
		return append([]string{}, probe.ids...) // 负缓存期内返回旧名单（可能为空）
	}
	r.modelsMu.Unlock()

	r.mu.RLock()
	var s *slot
	if len(ps.slots) > 0 {
		s = ps.slots[0]
	}
	r.mu.RUnlock()
	if s == nil {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.baseURL+"/v1/models", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	resp, err := r.http.Do(req)
	if err != nil {
		r.markProbeFail(provider)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		r.markProbeFail(provider)
		return nil
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		r.markProbeFail(provider)
		return nil
	}
	ids := make([]string, 0, len(payload.Data))
	for _, d := range payload.Data {
		if d.ID != "" {
			ids = append(ids, d.ID)
		}
	}
	r.modelsMu.Lock()
	r.modelsCache[provider] = modelsProbe{ids: ids, fetched: time.Now()}
	r.modelsMu.Unlock()
	return ids
}

func (r *Registry) markProbeFail(provider string) {
	r.modelsMu.Lock()
	probe := r.modelsCache[provider]
	probe.lastFail = time.Now()
	r.modelsCache[provider] = probe
	r.modelsMu.Unlock()
}
