// modeltest.go 面板「测试模型」端点（POST /panel/api/models/test）。
//
// 功能移植自 cursor-byok 的 test_model：固定 prompt 打一次真实流式请求，
// 返回首字延迟/总耗时/输出 tokens/速率（见 internal/modeltest 包注释）。
//
// 路由与执行：
//   - model 带供应商前缀（"artex:xxx"）→ provider.Registry 直连（不消耗
//     CodeBuddy 池在途名额）；
//   - 无前缀 / cn: / global: → 从池中取一个可用账号经 upstream.ChatStream
//     发出（真实检验账号池到上游的完整链路，会消耗账号一次对话配额——
//     面板前端已做确认提示）。
//
// 并发语义：test_id 由前端生成（uuid），重复提交同 id 幂等（同 id 已在跑
// 返回 409）；DELETE /panel/api/models/test/{id} 取消（cancel 对应 ctx）。
package panel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/modeltest"
	"github.com/linguo2625469/workbuddy2api-panel/internal/reqlog"
	"github.com/linguo2625469/workbuddy2api-panel/internal/server"
	"github.com/linguo2625469/workbuddy2api-panel/internal/session"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

// modelTestRequest 测试请求体。
type modelTestRequest struct {
	Model  string `json:"model"`   // 网关模型名（可带 cn:/global:/供应商: 前缀）
	TestID string `json:"test_id"` // 前端生成的幂等 id（uuid）
	UID    string `json:"uid"`     // 可选：指定 CodeBuddy 账号测试（空 = 池自动选号）
}

// modelTestSession 进行中的测试（取消用）。
type modelTestSession struct {
	cancel context.CancelFunc
	model  string
}

// modelTestMu/modelTests 进行中测试注册表（对齐 cursor-byok 的 model_tests）。
// 面板常驻进程，测试有 45s 超时兜底，容量天然有界。
var (
	modelTestMu sync.Mutex
	modelTests  = map[string]modelTestSession{}
)

// modelTest 执行一次连通性测试（同步阻塞至完成/超时/取消，最长 45s）。
func (p *Panel) modelTest(w http.ResponseWriter, r *http.Request) {
	var req modelTestRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "parse body: "+err.Error())
		return
	}
	if req.Model == "" {
		writeErr(w, http.StatusBadRequest, "model is required")
		return
	}
	if req.TestID == "" {
		req.TestID = reqlog.NewRequestID()
	}

	// 注册测试会话（同 id 幂等：已在跑 → 409）。
	ctx, cancel := context.WithTimeout(r.Context(), modeltest.Timeout)
	modelTestMu.Lock()
	if _, exists := modelTests[req.TestID]; exists {
		modelTestMu.Unlock()
		cancel()
		writeErr(w, http.StatusConflict, "test already running: "+req.TestID)
		return
	}
	modelTests[req.TestID] = modelTestSession{cancel: cancel, model: req.Model}
	modelTestMu.Unlock()
	defer func() {
		modelTestMu.Lock()
		delete(modelTests, req.TestID)
		modelTestMu.Unlock()
		cancel()
	}()

	realm, providerName, bare := server.ResolveModel(req.Model)
	body := modeltest.RequestBody(bare)

	var rc io.ReadCloser
	var status int
	var respBody []byte
	var err error

	switch {
	case providerName != "":
		// 供应商直连通道。
		if p.cfg.Providers == nil || !p.cfg.Providers.Has(providerName) {
			writeErr(w, http.StatusNotFound, "provider not registered: "+providerName)
			return
		}
		res, _ := p.cfg.Providers.ChatStream(ctx, providerName, bare, body)
		rc, status, respBody, err = res.RC, res.Status, res.RespBody, res.Err
	default:
		// CodeBuddy 池通道：指定 uid 或自动选号。
		acct := p.pickTestAccount(req.UID, bare, realm)
		if acct == nil {
			writeErr(w, http.StatusServiceUnavailable, "no available account for realm "+realm)
			return
		}
		meta := upstream.ChatMeta{ConversationRequestID: session.TurnRequestID("modeltest:" + req.TestID)}
		rc, status, respBody, err = p.cfg.Upstream.ChatStreamContext(ctx, acct, body, "", meta)
	}

	if err != nil {
		writeErr(w, http.StatusBadGateway, "transport: "+err.Error())
		return
	}
	if status >= 400 {
		msg := strings.TrimSpace(string(respBody))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		writeErr(w, status, fmt.Sprintf("upstream http %d: %s", status, msg))
		return
	}
	if rc == nil {
		writeErr(w, http.StatusBadGateway, "upstream returned no stream")
		return
	}
	defer rc.Close()

	res, err := modeltest.Run(ctx, rc)
	if err != nil {
		if ctx.Err() != nil {
			writeErr(w, 499, "test cancelled") // 非标准状态码：nginx 语义"客户端关闭请求"
			return
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
}

// pickTestAccount 选测试账号：指定 uid 优先；否则按 realm 取第一个可用号。
func (p *Panel) pickTestAccount(uid, model, realm string) *auth.Auth {
	if uid != "" {
		return p.cfg.Pool.AuthByUID(uid)
	}
	if uids := p.cfg.Pool.AvailableUIDsForRealm(realm); len(uids) > 0 {
		return p.cfg.Pool.AuthByUID(uids[0])
	}
	return nil
}

// modelTestCancel 取消进行中的测试（幂等：未知 id 也返回 ok）。
func (p *Panel) modelTestCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	modelTestMu.Lock()
	if sess, ok := modelTests[id]; ok {
		sess.cancel()
	}
	modelTestMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
