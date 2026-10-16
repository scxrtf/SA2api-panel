package modeltest

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestRunUsageAndDone(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{\"completion_tokens\":42}}\n\n" +
		"data: [DONE]\n\n"
	res, err := Run(context.Background(), strings.NewReader(sse))
	if err != nil {
		t.Fatal(err)
	}
	if res.Output != "hello world" {
		t.Fatalf("output=%q", res.Output)
	}
	if res.OutputTokens != 42 || res.TokensEstimated {
		t.Fatalf("tokens=%d estimated=%v, want 42/false", res.OutputTokens, res.TokensEstimated)
	}
	if res.FirstValidResponseMs == nil {
		t.Fatal("first_valid_response_ms nil despite content frames")
	}
	// 内存流耗时可 <1ms，tps 允许为 0；只校验不为负。
	if res.TokensPerSecond < 0 {
		t.Fatalf("tps=%v", res.TokensPerSecond)
	}
}

func TestRunEstimateWithoutUsage(t *testing.T) {
	// 无 usage 帧：按 4 字符≈1 token 估算并标注。
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"12345678\"}}]}\n\ndata: [DONE]\n\n"
	res, err := Run(context.Background(), strings.NewReader(sse))
	if err != nil {
		t.Fatal(err)
	}
	if !res.TokensEstimated || res.OutputTokens != 2 {
		t.Fatalf("tokens=%d estimated=%v, want 2/true", res.OutputTokens, res.TokensEstimated)
	}
}

func TestRunNoDoneStillOK(t *testing.T) {
	// 聚合站常不发 [DONE]：流结束即出结果，不算错误。
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"
	res, err := Run(context.Background(), strings.NewReader(sse))
	if err != nil {
		t.Fatal(err)
	}
	if res.Output != "partial" {
		t.Fatalf("output=%q", res.Output)
	}
}

func TestRunEmptyStream(t *testing.T) {
	if _, err := Run(context.Background(), strings.NewReader("data: [DONE]\n\n")); err == nil {
		t.Fatal("empty stream should error")
	}
}

func TestRunCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// 永不结束的流：pipe 一端不写数据，取消应立即返回。
	r, w := io.Pipe()
	defer w.Close()
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	if _, err := Run(ctx, r); err == nil || err != context.Canceled {
		t.Fatalf("err=%v want context.Canceled", err)
	}
}

func TestRequestBodyShape(t *testing.T) {
	body := string(RequestBody("m1"))
	for _, want := range []string{`"model":"m1"`, `"stream":true`, `include_usage`, TestPrompt[:30]} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q: %s", want, body)
		}
	}
}
