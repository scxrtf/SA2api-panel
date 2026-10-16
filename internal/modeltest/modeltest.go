// Package modeltest 模型连通性测试（面板「测试模型」功能）。
//
// 设计移植自 cursor-byok 的 test_model（server/src/control/service.rs），
// 指标口径完全对齐：固定 prompt 请求一次完整流式生成，测量
// 首字延迟（TTFB）/总耗时/输出 tokens/速率（tokens/s），usage 缺失时按
// 4 字符≈1 token 估算并标注 tokens_estimated。
//
// 与 cursor-byok 的差异（适配本网关架构）：
//   - 路由走网关自身协议（cn:/global:/供应商: 前缀），由调用方注入
//     执行闭包（CodeBuddy 池选号 / 供应商直连），本包只管计时与聚合；
//   - 取消经 context（面板取消端点 cancel 对应 ctx），而非注册表 token；
//   - 测试流量记入 usage 台账（调用方负责，标记 realm=provider:"__test__"）。
package modeltest

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// TestPrompt 固定测试提示词：强制一段可预期长度的纯文本输出，
// 数字序列对任何模型都无需工具/推理，避免思考档位污染速率读数。
// 与 cursor-byok 同一句（保持跨工具读数可比）。
const TestPrompt = "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation."

// Timeout 单次测试总超时（对齐 cursor-byok 的 45s）。
const Timeout = 45 * time.Second

// Result 连通性测试结果（字段名对齐 cursor-byok 的 ModelConnectivityResult，
// 面板前端可直接复用其展示口径）。
type Result struct {
	// DurationMs 端到端总耗时（请求发出 → 流结束）。
	DurationMs int64 `json:"duration_ms"`
	// FirstValidResponseMs 首个有效内容帧到达耗时（TTFB）；nil = 未收到。
	FirstValidResponseMs *int64 `json:"first_valid_response_ms"`
	// OutputTokens 输出 token 数：usage 精确值优先，缺失时按输出文本估算。
	OutputTokens int64 `json:"output_tokens"`
	// TokensPerSecond 输出速率 = OutputTokens / DurationMs。
	TokensPerSecond float64 `json:"tokens_per_second"`
	// TokensEstimated true = OutputTokens 是估算值（上游未给 usage）。
	TokensEstimated bool `json:"tokens_estimated"`
	// Output 完整输出文本（截断展示由前端负责）。
	Output string `json:"output"`
}

// RequestBody 构造测试请求体（OpenAI chat.completions，强制流式拿 usage）。
func RequestBody(model string) []byte {
	body, _ := json.Marshal(map[string]any{
		"model":  model,
		"stream": true,
		"messages": []map[string]any{
			{"role": "user", "content": TestPrompt},
		},
		"stream_options": map[string]any{"include_usage": true},
	})
	return body
}

// Run 消费一条 OpenAI SSE 流（rc 由调用方关闭），聚合成 Result。
// ctx 取消 → 返回 ctx.Err()（调用方据此标记"已取消"而非错误）。
// 流提前结束（无 [DONE]）不算错误：以已收到的内容出结果（部分供应商
// 不发 DONE；cursor-byok 的严格语义在其自研协议层，对聚合站过苛）。
func Run(ctx context.Context, rc io.Reader) (*Result, error) {
	started := time.Now()
	var firstAt *time.Duration
	var output strings.Builder
	var outputTokens int64
	finished := false

	lineCh := make(chan string, 64)
	errCh := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(rc)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			lineCh <- sc.Text()
		}
		close(lineCh)
		errCh <- sc.Err()
	}()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case line, ok := <-lineCh:
			if !ok {
				// 流结束。
				if err := <-errCh; err != nil && !finished {
					return nil, fmt.Errorf("read stream: %w", err)
				}
				return finish(started, firstAt, &output, outputTokens, finished)
			}
			line = strings.TrimRight(line, "\r")
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimPrefix(line, "data: ")
			if payload == "[DONE]" {
				finished = true
				continue
			}
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
				Usage struct {
					CompletionTokens int64 `json:"completion_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(payload), &chunk) != nil {
				continue
			}
			for _, c := range chunk.Choices {
				text := c.Delta.Content
				if text == "" {
					text = c.Message.Content
				}
				if text != "" {
					if firstAt == nil {
						d := time.Since(started)
						firstAt = &d
					}
					output.WriteString(text)
				}
			}
			if chunk.Usage.CompletionTokens > 0 {
				outputTokens = chunk.Usage.CompletionTokens
			}
		}
	}
}

// finish 计算最终指标。
func finish(started time.Time, firstAt *time.Duration, output *strings.Builder, outputTokens int64, _ bool) (*Result, error) {
	elapsed := time.Since(started)
	out := strings.TrimSpace(output.String())
	if out == "" && outputTokens == 0 {
		return nil, fmt.Errorf("model connectivity test received no valid response")
	}
	estimated := outputTokens == 0
	if estimated {
		outputTokens = estimateOutputTokens(out)
	}
	res := &Result{
		DurationMs:      elapsed.Milliseconds(),
		OutputTokens:    outputTokens,
		TokensEstimated: estimated,
		Output:          out,
	}
	if firstAt != nil {
		ms := firstAt.Milliseconds()
		res.FirstValidResponseMs = &ms
	}
	if elapsed > 0 {
		res.TokensPerSecond = float64(outputTokens) / elapsed.Seconds()
	}
	return res, nil
}

// estimateOutputTokens 估算输出 token 数（4 字符 ≈ 1 token，对齐
// cursor-byok 的 estimate_output_tokens 口径；中英文混合文本偏保守）。
func estimateOutputTokens(s string) int64 {
	n := int64(len([]rune(s)))
	if n == 0 {
		return 0
	}
	return (n + 3) / 4
}
