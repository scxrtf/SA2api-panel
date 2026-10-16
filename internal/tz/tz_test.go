package tz

import (
	"testing"
	"time"
)

func TestBeijingOffset(t *testing.T) {
	// 固定 +8 偏移（无夏令时）：任取冬夏两点，offset 必须恒为 28800 秒。
	for _, ts := range []time.Time{
		time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC),
	} {
		_, off := ts.In(Beijing).Zone()
		if off != 8*3600 {
			t.Fatalf("offset=%d want 28800 at %v", off, ts)
		}
	}
}

// TestNowAnchoredRegardlessOfLocal 核心回归：即便把进程时区拨成 UTC
//（模拟 Railway 容器），Beijing 锚点仍给出 UTC+8 视图——这是本次"时间锚定
// 北京时间"的全部意义。
func TestNowAnchoredRegardlessOfLocal(t *testing.T) {
	old := time.Local
	time.Local = time.UTC
	defer func() { time.Local = old }()

	// UTC 2026-10-16 00:30 = 北京 2026-10-16 08:30。
	utc := time.Date(2026, 10, 16, 0, 30, 0, 0, time.UTC)
	bj := utc.In(Beijing)
	if bj.Hour() != 8 || bj.Day() != 16 {
		t.Fatalf("beijing view = %v, want 08:30 day 16", bj)
	}
	if _, off := Now().Zone(); off != 8*3600 {
		t.Fatalf("Now() zone offset = %d, want 28800", off)
	}
}
