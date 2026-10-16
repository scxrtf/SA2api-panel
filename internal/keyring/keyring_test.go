package keyring

import (
	"encoding/json"
	"testing"
)

func TestEntryEnabledDefaultTrue(t *testing.T) {
	var e Entry
	if err := json.Unmarshal([]byte(`{"key":"sk-x","name":"alice"}`), &e); err != nil {
		t.Fatal(err)
	}
	if !e.Enabled {
		t.Fatal("enabled must default to true")
	}
	var e2 Entry
	if err := json.Unmarshal([]byte(`{"key":"sk-y","enabled":false}`), &e2); err != nil {
		t.Fatal(err)
	}
	if e2.Enabled {
		t.Fatal("explicit false must be honored")
	}
}

func TestRingIdentifyAndKeys(t *testing.T) {
	r := New([]Entry{
		{Key: "sk-aaa", Name: "alice", Enabled: true},
		{Key: "sk-bbb", Name: "bob", Enabled: false}, // 吊销
		{Key: "sk-ccc", Enabled: true},               // 无名 → 回落掩码
	})
	if r.Empty() {
		t.Fatal("ring must not be empty")
	}
	if got := r.Identify("sk-aaa"); got != "alice" {
		t.Fatalf("identify=%q", got)
	}
	if got := r.Identify("sk-bbb"); got != "" {
		t.Fatalf("disabled key must not identify, got %q", got)
	}
	if got := r.Identify("sk-ccc"); got != Mask("sk-ccc") {
		t.Fatalf("fallback mask name=%q", got)
	}
	if got := r.Identify("sk-nope"); got != "" {
		t.Fatalf("unknown key=%q", got)
	}
	keys := r.Keys()
	if len(keys) != 2 {
		t.Fatalf("keys=%v", keys)
	}
}

func TestRingStoreReplaces(t *testing.T) {
	r := New([]Entry{{Key: "sk-old", Name: "o", Enabled: true}})
	r.Store([]Entry{{Key: "sk-new", Name: "n", Enabled: true}})
	if got := r.Identify("sk-old"); got != "" {
		t.Fatalf("old key still identifies: %q", got)
	}
	if got := r.Identify("sk-new"); got != "n" {
		t.Fatalf("identify=%q", got)
	}
	r.Store(nil)
	if !r.Empty() {
		t.Fatal("empty after Store(nil)")
	}
}

func TestMask(t *testing.T) {
	if got := Mask("sk-abcdefghijklmnop"); got != "sk-ab****mnop" {
		t.Fatalf("mask=%q", got)
	}
	if got := Mask("short"); got != "***" {
		t.Fatalf("short mask=%q", got)
	}
}
