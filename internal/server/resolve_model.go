package server

import "strings"

// resolveModel 解析模型名协议（PLAN D6 + 聚合供应商扩展）：
//
//	分布式前缀： "[realm:]model" / "[供应商:]model"
//
// 取第一个 ":"，前段恰为 "cn"/"global" 剥离（内置 realm）；其余前缀原样剥离
// 并作为供应商名返回——是否真实存在由调用方查 provider.Registry 判定。
// bare 即出站/选号/账本使用的裸模型名。
//
// 返回三段：(realm, provider, bare)。realm 与 provider 互斥：
//   - 前缀是 cn/global → (前缀, "", bare)
//   - 前缀是其他名字 → ("", 前缀, bare)
//   - 无前缀          → ("cn", "", 原串)（CN 现状零回归）
//
// 导出为 ResolveModel（cmd/server/main.go 粘性闭包需要），包内简写 resolveModel。
func resolveModel(model string) (realm, provider, bare string) {
	idx := strings.IndexByte(model, ':')
	if idx < 0 {
		return "cn", "", model
	}
	prefix := model[:idx]
	switch prefix {
	case "cn", "global":
		return prefix, "", model[idx+1:]
	default:
		return "", prefix, model[idx+1:]
	}
}

// ResolveModel 是 resolveModel 的导出面（跨包调用）。
func ResolveModel(model string) (realm, provider, bare string) { return resolveModel(model) }
