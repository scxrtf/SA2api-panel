// bench_test.go SSE 聚合器吞吐压测：Run 是逐行 Scanner + 每帧 JSON 解析，
// 量化「长流式输出会不会成为面板测试端点的 CPU 瓶颈」。
package modeltest

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// benchStream 构造 n 帧内容 + usage + DONE 的 SSE 流。
func benchStream(frames int) string {
	var sb strings.Builder
	for i := 0; i < frames; i++ {
		fmt.Fprintf(&sb, "data: {\"choices\":[{\"delta\":{\"content\":\"token-%d \"}}]}\n\n", i)
	}
	fmt.Fprintf(&sb, "data: {\"choices\":[],\"usage\":{\"completion_tokens\":%d}}\n\ndata: [DONE]\n\n", frames)
	return sb.String()
}

func BenchmarkRun(b *testing.B) {
	for _, frames := range []int{100, 1000, 10000} {
		sse := benchStream(frames)
		b.Run(fmt.Sprintf("frames=%d", frames), func(b *testing.B) {
			b.SetBytes(int64(len(sse)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := Run(context.Background(), strings.NewReader(sse)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
