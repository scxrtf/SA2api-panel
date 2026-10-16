// anthropic.go Anthropic Messages API 兼容端点（POST /v1/messages）。
//
// 存在理由：Claude Code 及 ccswitch 等 Anthropic 系客户端只认
// ANTHROPIC_BASE_URL + /v1/messages 协议。本端点把这些请求翻译成
// OpenAI chat.completions 请求体，内部复用 chatCompletions 全部管线
// （cn:/global:/供应商: 前缀路由、选号、重试、脱敏、用量记录），再把
// 响应翻回 Anthropic 形态（非流式 message 对象 / 流式 SSE 事件流）。
//
// 边界（有意不做的）：
//   - 请求中 max_tokens 不透出（CodeBuddy 上游自行决定生成长度）；
//   - usage 完整四段（input/output/cache_read/cache_creation）仅在
//     客户端请求 anthropic-beta: context-management 头时透出（对齐
//     Claude Code 行为，该头只影响 usage 字段展示，不启用服务端压缩）；
//   - 流式响应先聚合再重建 Anthropic 事件流（OpenAI 增量粒度与
//     Anthropic 块语义不一一对应，聚合重建最稳）。
package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// anthropicContextMgmtBeta 触发 usage 四段透出的 beta 头前缀（Claude Code
// 会发送 "context-management-2025-06-27" 一类的版本化值，前缀匹配即可）。
const anthropicContextMgmtBeta = "context-management"

// anthropicRequest Messages API 请求体（宽松解析：未知字段忽略）。
type anthropicRequest struct {
	Model    string          `json:"model"`
	System   json.RawMessage `json:"system"` // string 或 [{type:"text",text:...}]
	Messages json.RawMessage `json:"messages"`
	Stream   bool            `json:"stream"`
	Tools    json.RawMessage `json:"tools"`
}

// anthropicMessages 路由入口：翻译 → 内部调用 chatCompletions → 翻译回。
func (h *Handler) anthropicMessages(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "read body: "+err.Error())
		return
	}
	var req anthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "parse body: "+err.Error())
		return
	}
	if req.Model == "" {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "model is required")
		return
	}

	openaiBody, err := anthropicToOpenAI(&req)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	// 内部调用 chatCompletions：以原始请求的 context 构造内部请求
	// （r.Context() 承载 withAuth 写入的 key 名与取消信号）。
	inner, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		"http://internal/v1/chat/completions", bytes.NewReader(openaiBody))
	if err != nil {
		writeAnthropicError(w, http.StatusInternalServerError, "api_error", err.Error())
		return
	}
	inner.Header.Set("Content-Type", "application/json")

	capture := &anthropicCapture{header: http.Header{}}
	h.chatCompletions(capture, inner)

	// 上游错误（非 2xx）：OpenAI 错误形态翻成 Anthropic 错误形态，原文 message 透出。
	if capture.status >= 400 || capture.status == 0 {
		status := capture.status
		if status == 0 {
			status = http.StatusBadGateway
		}
		msg := strings.TrimSpace(string(capture.body.Bytes()))
		// OpenAI 错误体是 {"error":{"message":...}}；提取 message 字段避免双层嵌套。
		var oe struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(capture.body.Bytes(), &oe) == nil && oe.Error.Message != "" {
			msg = oe.Error.Message
		}
		if msg == "" {
			msg = fmt.Sprintf("upstream returned http %d", status)
		}
		writeAnthropicError(w, status, anthropicErrorType(status), msg)
		return
	}

	wantCtxMgmt := hasAnthropicBeta(r, anthropicContextMgmtBeta)

	if !req.Stream {
		respBody, usage, err := openaiResponseUsage(capture.body.Bytes())
		if err != nil {
			writeAnthropicError(w, http.StatusBadGateway, "api_error", "parse upstream response: "+err.Error())
			return
		}
		out := openaiToAnthropicMessage(respBody, usage, wantCtxMgmt)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(capture.status)
		_ = json.NewEncoder(w).Encode(out)
		return
	}

	// 流式：内部响应是聚合前的 OpenAI SSE（data: 帧）。聚合为完整文本与
	// tool_calls 后重建 Anthropic 事件流——不做逐帧转写，因为 OpenAI 流
	// 的增量粒度（token 片段 + tool_call 分片）与 Anthropic 的块语义
	// （content_block_start/delta/stop）并非一一对应，聚合后重建最稳。
	frames, usage, err := aggregateOpenAISSE(capture.body.Bytes())
	if err != nil {
		writeAnthropicError(w, http.StatusBadGateway, "api_error", "parse upstream stream: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	writeAnthropicStream(w, frames, usage, wantCtxMgmt)
}

// anthropicCapture 捕获 chatCompletions 写出的响应（状态码 + 响应体 + 头）。
type anthropicCapture struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (c *anthropicCapture) Header() http.Header { return c.header }

func (c *anthropicCapture) WriteHeader(status int) { c.status = status }

func (c *anthropicCapture) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return c.body.Write(p)
}

// Flush 兼容 chatCompletions 内部的 http.Flusher 断言（流式透传路径）：
// 数据已在 body 缓冲，无需真刷。
func (c *anthropicCapture) Flush() {}

// hasAnthropicBeta 判断请求是否声明了指定前缀的 anthropic-beta 能力
// （同一头可出现多次/逗号分隔，前缀匹配版本化值）。
func hasAnthropicBeta(r *http.Request, prefix string) bool {
	for _, v := range r.Header.Values("anthropic-beta") {
		for _, item := range strings.Split(v, ",") {
			if strings.HasPrefix(strings.TrimSpace(item), prefix) {
				return true
			}
		}
	}
	return false
}

// anthropicToOpenAI Messages 请求体 → chat.completions 请求体。
//
// 映射规则：
//   - model 原样保留（网关的 cn:/global:/供应商: 前缀路由照常生效；
//     用户在 ccswitch/Claude Code 侧直接填网关模型名）；
//   - system（string 或 content block 数组）展平为一条 role=system 消息
//     放在最前；多段文本以 \n\n 连接；
//   - messages[].content 为 string → 原样；为 block 数组 →
//     text 段拼接为字符串；tool_use → assistant.tool_calls；
//     tool_result → role=tool 消息；image 段拒绝（CodeBuddy 私有管线
//     的图片语义与 Anthropic base64 块不同构，强转会产生 11133 假阴性）；
//   - tools → OpenAI function 形态（name/description/input_schema→parameters）；
//   - max_tokens / thinking / tool_choice 不透出（上游自行决定）。
func anthropicToOpenAI(req *anthropicRequest) ([]byte, error) {
	var messages []map[string]any

	if sys := anthropicSystemText(req.System); sys != "" {
		messages = append(messages, map[string]any{"role": "system", "content": sys})
	}

	var raw []map[string]json.RawMessage
	if len(req.Messages) > 0 {
		if err := json.Unmarshal(req.Messages, &raw); err != nil {
			return nil, fmt.Errorf("parse messages: %w", err)
		}
	}
	for i, m := range raw {
		converted, err := anthropicMessageToOpenAI(m)
		if err != nil {
			return nil, fmt.Errorf("messages[%d]: %w", i, err)
		}
		messages = append(messages, converted...)
	}
	if len(messages) == 0 {
		return nil, fmt.Errorf("messages is required")
	}

	out := map[string]any{
		"model":    req.Model,
		"messages": messages,
	}
	if req.Stream {
		out["stream"] = true
	}
	if len(req.Tools) > 0 {
		tools, err := anthropicToolsToOpenAI(req.Tools)
		if err != nil {
			return nil, fmt.Errorf("tools: %w", err)
		}
		if len(tools) > 0 {
			out["tools"] = tools
		}
	}
	return json.Marshal(out)
}

// anthropicSystemText 把 system 字段（string 或 [{type:"text",text}]）展平为纯文本。
func anthropicSystemText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// anthropicMessageToOpenAI 转换单条消息，可能展开为多条
// （assistant 的 tool_use 块 → 一条带 tool_calls 的 assistant 消息；
// user 侧的 tool_result 块 → 对应数量的 role=tool 消息）。
func anthropicMessageToOpenAI(m map[string]json.RawMessage) ([]map[string]any, error) {
	var role string
	if raw, ok := m["role"]; ok {
		_ = json.Unmarshal(raw, &role)
	}
	contentRaw, hasContent := m["content"]
	if !hasContent || len(contentRaw) == 0 || string(contentRaw) == "null" {
		if role == "" {
			return nil, fmt.Errorf("missing role")
		}
		return []map[string]any{{"role": role, "content": ""}}, nil
	}

	// 字符串形态：原样。
	var s string
	if json.Unmarshal(contentRaw, &s) == nil {
		if role == "" {
			return nil, fmt.Errorf("missing role")
		}
		return []map[string]any{{"role": role, "content": s}}, nil
	}

	// block 数组形态。
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(contentRaw, &blocks); err != nil {
		return nil, fmt.Errorf("unsupported content form")
	}
	var texts []string
	var toolCalls []map[string]any
	var toolResults []map[string]any
	for bi, b := range blocks {
		var btype string
		_ = json.Unmarshal(b["type"], &btype)
		switch btype {
		case "text":
			var t string
			_ = json.Unmarshal(b["text"], &t)
			if t != "" {
				texts = append(texts, t)
			}
		case "image":
			return nil, fmt.Errorf("content[%d]: image blocks are not supported (use the OpenAI endpoint with image_url parts)", bi)
		case "tool_use":
			var id, name string
			_ = json.Unmarshal(b["id"], &id)
			_ = json.Unmarshal(b["name"], &name)
			input := json.RawMessage(`{}`)
			if raw, ok := b["input"]; ok && len(raw) > 0 {
				input = raw
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   id,
				"type": "function",
				"function": map[string]any{
					"name":      name,
					"arguments": string(input),
				},
			})
		case "tool_result":
			var toolUseID string
			_ = json.Unmarshal(b["tool_use_id"], &toolUseID)
			msg := map[string]any{
				"role":    "tool",
				"content": anthropicToolResultText(b["content"]),
			}
			if toolUseID != "" {
				msg["tool_call_id"] = toolUseID
			}
			toolResults = append(toolResults, msg)
		default:
			// 未知块类型（thinking / cache_control 附着块等）→ 跳过，不中断。
		}
	}

	var out []map[string]any
	// user 消息的 tool_result 块在 OpenAI 里是独立的 role=tool 消息，必须先于
	// 文本内容输出（OpenAI 要求 tool 消息紧跟在带 tool_calls 的 assistant 后）。
	out = append(out, toolResults...)
	if role == "assistant" {
		msg := map[string]any{"role": "assistant"}
		if len(texts) > 0 {
			msg["content"] = strings.Join(texts, "\n\n")
		} else {
			msg["content"] = ""
		}
		if len(toolCalls) > 0 {
			msg["tool_calls"] = toolCalls
		}
		out = append(out, msg)
	} else if len(texts) > 0 || len(toolResults) == 0 {
		if role == "" {
			role = "user"
		}
		out = append(out, map[string]any{"role": role, "content": strings.Join(texts, "\n\n")})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("empty message after conversion")
	}
	return out, nil
}

// anthropicToolResultText tool_result 的 content 展平为纯文本
// （string 原样；block 数组取 text 段拼接；其他形态原样序列化）。
func anthropicToolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var parts []string
		for _, b := range blocks {
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return string(raw)
}

// anthropicToolsToOpenAI tools 数组 → OpenAI function 工具声明。
func anthropicToolsToOpenAI(raw json.RawMessage) ([]map[string]any, error) {
	var tools []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tools); err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		var name, desc string
		_ = json.Unmarshal(t["name"], &name)
		_ = json.Unmarshal(t["description"], &desc)
		if name == "" {
			continue
		}
		schema := json.RawMessage(`{"type":"object"}`)
		if raw, ok := t["input_schema"]; ok && len(raw) > 0 {
			schema = raw
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        name,
				"description": desc,
				"parameters":  schema,
			},
		})
	}
	return out, nil
}

// anthropicUsage OpenAI usage → Anthropic usage 字段。
// ctxMgmt=false 时只透 input/output_tokens（Claude Code 常规读取的两个键）；
// ctxMgmt=true（anthropic-beta: context-management 头）补 cache_read/
// cache_creation_input_tokens（CodeBuddy 上游不区分缓存创建，miss 计数
// 作为"新写入前缀缓存"的最近似语义）。
type anthropicUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens,omitempty"`
}

func openaiUsageToAnthropic(usage map[string]any, ctxMgmt bool) anthropicUsage {
	var u anthropicUsage
	if usage == nil {
		return u
	}
	u.InputTokens = jsonInt64(usage["prompt_tokens"])
	u.OutputTokens = jsonInt64(usage["completion_tokens"])
	if ctxMgmt {
		u.CacheReadInputTokens = jsonInt64(usage["prompt_cache_hit_tokens"])
		u.CacheCreationInputTokens = jsonInt64(usage["prompt_cache_miss_tokens"])
	}
	return u
}

// jsonInt64 宽松提取 JSON 数值（float64 / json.Number / string 兼容）。
func jsonInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case json.Number:
		i, _ := n.Int64()
		return i
	case string:
		var f float64
		if err := json.Unmarshal([]byte(n), &f); err == nil {
			return int64(f)
		}
	}
	return 0
}

// openaiResponseUsage 解析非流式 chat.completions 响应，返回完整响应 map 与 usage。
func openaiResponseUsage(body []byte) (map[string]any, map[string]any, error) {
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, nil, err
	}
	usage, _ := resp["usage"].(map[string]any)
	return resp, usage, nil
}

// openaiToAnthropicMessage 非流式 OpenAI 响应 → Anthropic message 对象。
func openaiToAnthropicMessage(resp map[string]any, usage map[string]any, ctxMgmt bool) map[string]any {
	out := map[string]any{
		"id":    firstString(resp, "id"),
		"type":  "message",
		"role":  "assistant",
		"model": firstString(resp, "model"),
	}
	if out["id"] == "" {
		out["id"] = "msg_gateway"
	}
	content, stopReason := openaiChoiceToAnthropicContent(resp)
	out["content"] = content
	out["stop_reason"] = stopReason
	out["stop_sequence"] = nil
	out["usage"] = openaiUsageToAnthropic(usage, ctxMgmt)
	return out
}

// openaiChoiceToAnthropicContent 从首个 choice 提取 content blocks 与 stop_reason。
// 纯文本 → [text 块]；带 tool_calls → text 块（如有）+ tool_use 块序列。
func openaiChoiceToAnthropicContent(resp map[string]any) ([]map[string]any, string) {
	choices, _ := resp["choices"].([]any)
	if len(choices) == 0 {
		return []map[string]any{{"type": "text", "text": ""}}, "end_turn"
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)

	var blocks []map[string]any
	if text, ok := message["content"].(string); ok && text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	stopReason := "end_turn"
	if tcs, ok := message["tool_calls"].([]any); ok {
		for _, raw := range tcs {
			tc, _ := raw.(map[string]any)
			fn, _ := tc["function"].(map[string]any)
			name, _ := fn["name"].(string)
			args, _ := fn["arguments"].(string)
			var input any
			if json.Unmarshal([]byte(args), &input) != nil {
				input = map[string]any{}
			}
			blocks = append(blocks, map[string]any{
				"type":  "tool_use",
				"id":    firstString(tc, "id"),
				"name":  name,
				"input": input,
			})
		}
		if len(tcs) > 0 {
			stopReason = "tool_use"
		}
	}
	if fr, _ := choice["finish_reason"].(string); fr == "length" {
		stopReason = "max_tokens"
	}
	if len(blocks) == 0 {
		blocks = []map[string]any{{"type": "text", "text": ""}}
	}
	return blocks, stopReason
}

// openaiStreamFrame 聚合 OpenAI SSE 后的单轮完整输出。
type openaiStreamFrame struct {
	text      string
	toolCalls []openaiToolCall
	finish    string
}

type openaiToolCall struct {
	id   string
	name string
	args string
}

// aggregateOpenAISSE 把 chat.completions SSE 文本聚合为完整输出 + 末帧 usage。
// delta 片段按序拼接；tool_calls 按 index 归并（分片 arguments 累加）。
func aggregateOpenAISSE(body []byte) (*openaiStreamFrame, map[string]any, error) {
	frame := &openaiStreamFrame{}
	var usage map[string]any
	calls := map[int]*openaiToolCall{}
	var order []int

	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}
		var chunk map[string]any
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if u, ok := chunk["usage"].(map[string]any); ok {
			usage = u
		}
		choices, _ := chunk["choices"].([]any)
		for _, raw := range choices {
			choice, _ := raw.(map[string]any)
			if fr, _ := choice["finish_reason"].(string); fr != "" {
				frame.finish = fr
			}
			delta, _ := choice["delta"].(map[string]any)
			if delta == nil {
				delta, _ = choice["message"].(map[string]any)
			}
			if delta == nil {
				continue
			}
			if c, ok := delta["content"].(string); ok {
				frame.text += c
			}
			if tcs, ok := delta["tool_calls"].([]any); ok {
				for _, traw := range tcs {
					tc, _ := traw.(map[string]any)
					idx := int(jsonInt64(tc["index"]))
					slot, ok := calls[idx]
					if !ok {
						slot = &openaiToolCall{}
						calls[idx] = slot
						order = append(order, idx)
					}
					if id, _ := tc["id"].(string); id != "" {
						slot.id = id
					}
					if fn, _ := tc["function"].(map[string]any); fn != nil {
						if name, _ := fn["name"].(string); name != "" {
							slot.name = name
						}
						if args, _ := fn["arguments"].(string); args != "" {
							slot.args += args
						}
					}
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	for _, idx := range order {
		frame.toolCalls = append(frame.toolCalls, *calls[idx])
	}
	return frame, usage, nil
}

// writeAnthropicStream 输出 Anthropic 流式事件序列：
//
//	message_start → [content_block_start(text) → content_block_delta… → content_block_stop]
//	              → [tool_use 块序列] → message_delta(usage) → message_stop
//
// usage 在 message_start 里先透 input_tokens（output 置 0），
// message_delta 里透最终值——这是 Anthropic 协议的规定形态，
// Claude Code 的成本统计依赖 message_delta 的 output_tokens。
func writeAnthropicStream(w http.ResponseWriter, frame *openaiStreamFrame, usage map[string]any, ctxMgmt bool) {
	au := openaiUsageToAnthropic(usage, ctxMgmt)
	startUsage := au
	startUsage.OutputTokens = 0

	emit := func(event string, v any) {
		raw, err := json.Marshal(v)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	emit("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id":            "msg_gateway",
			"type":          "message",
			"role":          "assistant",
			"model":         "",
			"content":       []any{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage":         startUsage,
		},
	})

	idx := 0
	stopBlock := func() {
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
		idx++
	}

	if frame.text != "" {
		emit("content_block_start", map[string]any{
			"type":          "content_block_start",
			"index":         idx,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		emit("content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": idx,
			"delta": map[string]any{"type": "text_delta", "text": frame.text},
		})
		stopBlock()
	}

	stopReason := "end_turn"
	for _, tc := range frame.toolCalls {
		emit("content_block_start", map[string]any{
			"type":  "content_block_start",
			"index": idx,
			"content_block": map[string]any{
				"type":  "tool_use",
				"id":    tc.id,
				"name":  tc.name,
				"input": map[string]any{},
			},
		})
		emit("content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": idx,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": tc.args},
		})
		stopBlock()
		stopReason = "tool_use"
	}
	if frame.finish == "length" {
		stopReason = "max_tokens"
	}

	emit("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
		"usage": au,
	})
	emit("message_stop", map[string]any{"type": "message_stop"})
}

// firstString 取 map 中字符串字段（缺失/非字符串返回空串）。
func firstString(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// anthropicErrorType 按 HTTP 状态映射 Anthropic 错误类型。
func anthropicErrorType(status int) string {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "authentication_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status == http.StatusRequestEntityTooLarge:
		return "request_too_large"
	case status >= 500:
		return "api_error"
	default:
		return "invalid_request_error"
	}
}

// writeAnthropicError Anthropic 协议错误形态：{"type":"error","error":{...}}。
func writeAnthropicError(w http.ResponseWriter, status int, errType, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    errType,
			"message": msg,
		},
	})
}
