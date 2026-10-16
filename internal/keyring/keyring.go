// Package keyring 网关多 API 密钥（sk-key）管理：并发安全列表 + 请求归属识别。
//
// 背景：聚合网关对外服务多个使用者，需要给每个使用者一把独立 sk-key，并在
// 请求日志/用量里回答「这次调用是谁的 key 打来的」。鉴权本身仍走 httpauth
// 常量时间比较，本包只维护「key → 名字/启用状态」的映射与热替换。
//
// key 原文是凭证，面板与日志只展示掩码（Mask），完整值不出进程边界。
package keyring

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"sync"
)

// Entry 一把网关密钥。
type Entry struct {
	Key     string `json:"key"`            // 完整密钥（sk-...）；序列化进 config，面板不透出
	Name    string `json:"name"`           // 使用者标识（展示/统计用）；空时回落 Key 掩码
	Enabled bool   `json:"enabled"`        // false = 吊销（缺省 true，见 UnmarshalJSON）
	Note    string `json:"note,omitempty"` // 备注（仅面板展示）
}

// UnmarshalJSON 实现 enabled 缺省 true：键缺席 → true，显式 false → false。
// 注意：该缺省语义只对 JSON 路径生效；代码构造 Entry 必须显式给 Enabled 赋值。
func (e *Entry) UnmarshalJSON(raw []byte) error {
	// *bool 三态：nil=缺席→true；显式 true/false 照收。
	var a struct {
		Key     string `json:"key"`
		Name    string `json:"name"`
		Enabled *bool  `json:"enabled"`
		Note    string `json:"note"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return err
	}
	e.Key = a.Key
	e.Name = a.Name
	e.Note = a.Note
	e.Enabled = a.Enabled == nil || *a.Enabled
	return nil
}

// Ring 并发安全密钥环。Store 整体替换（与 livecfg 快照同风格）。
type Ring struct {
	mu      sync.RWMutex
	entries []Entry
	// hashes 启用的 key 的 SHA-256 摘要（鉴权比对用，避免热路径每把 key 现算）。
	hashes map[[32]byte]string // digest(key) → name
}

// New 以初始列表构建；nil 接收 nil（空环 = 未启用鉴权）。
func New(entries []Entry) *Ring {
	r := &Ring{}
	r.Store(entries)
	return r
}

// Store 整体替换密钥列表；enabled 缺省语义：JSON 反序列化默认 false，故调用方
// 传入的 Entry.Enabled 必须已按「缺省 true」归一化（见 config.normalize）。
func (r *Ring) Store(entries []Entry) {
	cp := make([]Entry, len(entries))
	copy(cp, entries)
	hashes := make(map[[32]byte]string, len(cp))
	for _, e := range cp {
		if !e.Enabled || e.Key == "" {
			continue
		}
		name := e.Name
		if name == "" {
			name = Mask(e.Key)
		}
		hashes[sha256.Sum256([]byte(e.Key))] = name
	}
	r.mu.Lock()
	r.entries = cp
	r.hashes = hashes
	r.mu.Unlock()
}

// Entries 返回当前列表副本（面板展示/配置回写用）。
func (r *Ring) Entries() []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	cp := make([]Entry, len(r.entries))
	copy(cp, r.entries)
	return cp
}

// Keys 返回启用的 key 原文列表（httpauth.VerifyAny 用）。
func (r *Ring) Keys() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.entries))
	for _, e := range r.entries {
		if e.Enabled && e.Key != "" {
			out = append(out, e.Key)
		}
	}
	return out
}

// Empty 报告环内是否没有任何启用密钥（空 = 不鉴权，与单 key 语义一致）。
func (r *Ring) Empty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.hashes) == 0
}

// Identify 识别请求凭证归属：命中返回 key 的展示名；未命中/未携带返回空串。
// 与 httpauth.VerifyAny 分开调用的原因：鉴权在 withAuth，归属识别只需一次，
// 且未启用鉴权（空环）时恒返回空串。
func (r *Ring) Identify(token string) string {
	if token == "" {
		return ""
	}
	d := sha256.Sum256([]byte(token))
	r.mu.RLock()
	defer r.mu.RUnlock()
	matched := ""
	for h, name := range r.hashes {
		if subtle.ConstantTimeCompare(d[:], h[:]) == 1 {
			matched = name
		}
	}
	return matched
}

// Mask 密钥展示掩码："sk-ab****wxyz"（头 5 尾 4）；过短全部打码。
func Mask(key string) string {
	if len(key) <= 9 {
		return "***"
	}
	return key[:5] + "****" + key[len(key)-4:]
}
