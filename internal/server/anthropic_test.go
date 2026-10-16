package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnthropicToOpenAI_Basic(t *testing.T) {
	req := &anthropicRequest{
		Model:    "cn:glm-5",
		System:   json.RawMessage(`"you are helpful"`),
		Messages: json.RawMessage(`[{"role":"user","content":"hi"}]`),
		Stream:   true,
	}
	raw, err := anthropicToOpenAI(req)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out["model"] != "cn:glm-5" {
		t.Fatalf("model=%v", out["model"])
	}
	if out["stream"] != true {
		t.Fatalf("stream=%v", out["stream"])
	}
	msgs := out["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len=%d", len(msgs))
	}
	if msgs[0].(map[string]any)["role"] != "system" {
		t.Fatalf("first msg role=%v", msgs[0])
	}
}

func TestAnthropicToOpenAI_ToolUseRoundTrip(t *testing.T) {
	req := &anthropicRequest{
		Model: "m",
		Messages: json.RawMessage(`[
		  {"role":"user","content":"what's the weather"},
		  {"role":"assistant","content":[
		    {"type":"text","text":"let me check"},
		    {"type":"tool_use","id":"call_1","name":"get_weather","input":{"city":"bj"}}
		  ]},
		  {"role":"user","content":[
		    {"type":"tool_result","tool_use_id":"call_1","content":"sunny"}
		  ]}
		]`),
		Tools: json.RawMessage(`[{"name":"get_weather","description":"w","input_schema":{"type":"object"}}]`),
	}
	raw, err := anthropicToOpenAI(req)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	msgs := out["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages len=%d: %v", len(msgs), msgs)
	}
	asst := msgs[1].(map[string]any)
	tcs := asst["tool_calls"].([]any)
	if len(tcs) != 1 {
		t.Fatalf("tool_calls=%v", tcs)
	}
	fn := tcs[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_weather" || !strings.Contains(fn["arguments"].(string), "bj") {
		t.Fatalf("fn=%v", fn)
	}
	toolMsg := msgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" {
		t.Fatalf("tool msg=%v", toolMsg)
	}
	tools := out["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools=%v", tools)
	}
}

func TestAnthropicToOpenAI_RejectsImage(t *testing.T) {
	req := &anthropicRequest{
		Model: "m",
		Messages: json.RawMessage(`[{"role":"user","content":[
		  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"x"}}
		]}]`),
	}
	if _, err := anthropicToOpenAI(req); err == nil {
		t.Fatal("expected image rejection")
	}
}

func TestAggregateOpenAISSE(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"f\",\"arguments\":\"{\\\"a\\\"\"}}]}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":1}\"}}]}}]}\n\n" +
		"data: {\"choices\":[{\"finish_reason\":\"tool_calls\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n" +
		"data: [DONE]\n\n"
	frame, usage, err := aggregateOpenAISSE([]byte(sse))
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if frame.text != "hello" {
		t.Fatalf("text=%q", frame.text)
	}
	if len(frame.toolCalls) != 1 || frame.toolCalls[0].args != `{"a":1}` {
		t.Fatalf("toolCalls=%+v", frame.toolCalls)
	}
	if frame.finish != "tool_calls" {
		t.Fatalf("finish=%q", frame.finish)
	}
	if jsonInt64(usage["prompt_tokens"]) != 10 {
		t.Fatalf("usage=%v", usage)
	}
}

func TestOpenAIUsageToAnthropic_CtxMgmtGate(t *testing.T) {
	usage := map[string]any{
		"prompt_tokens":            float64(100),
		"completion_tokens":        float64(20),
		"prompt_cache_hit_tokens":  float64(60),
		"prompt_cache_miss_tokens": float64(40),
	}
	u := openaiUsageToAnthropic(usage, false)
	if u.InputTokens != 100 || u.OutputTokens != 20 {
		t.Fatalf("u=%+v", u)
	}
	if u.CacheReadInputTokens != 0 || u.CacheCreationInputTokens != 0 {
		t.Fatalf("ctxMgmt=false must not expose cache fields: %+v", u)
	}
	u = openaiUsageToAnthropic(usage, true)
	if u.CacheReadInputTokens != 60 || u.CacheCreationInputTokens != 40 {
		t.Fatalf("ctxMgmt=true: %+v", u)
	}
}

func TestOpenAIToAnthropicMessage(t *testing.T) {
	resp := map[string]any{
		"id":    "chatcmpl-1",
		"model": "glm-5",
		"choices": []any{map[string]any{
			"finish_reason": "stop",
			"message":       map[string]any{"role": "assistant", "content": "hi"},
		}},
	}
	out := openaiToAnthropicMessage(resp, map[string]any{"prompt_tokens": float64(1), "completion_tokens": float64(2)}, false)
	if out["type"] != "message" || out["role"] != "assistant" {
		t.Fatalf("out=%v", out)
	}
	blocks := out["content"].([]map[string]any)
	if len(blocks) != 1 || blocks[0]["text"] != "hi" {
		t.Fatalf("blocks=%v", blocks)
	}
	if out["stop_reason"] != "end_turn" {
		t.Fatalf("stop_reason=%v", out["stop_reason"])
	}
}
