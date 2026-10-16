// Package httpauth 网关与面板共用的 Bearer 鉴权原语。
//
// 单独成包的原因：server（/v1/*、/status）与 panel（/panel/api/*）两处鉴权
// 必须完全同口径——此前各自复制了一份"字符串直接比较"的实现，既容易漂移，
// 又都带计时侧信道。统一到这里后，口径只有一份，且天然常量时间比较。
package httpauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// bearerPrefix 认证方案前缀（大小写敏感，与 HTTP 规范及既有实现一致）。
const bearerPrefix = "Bearer "

// VerifyBearer 校验请求头是否携带正确的 Bearer 密钥。
//
// key 为空表示"未启用鉴权"，恒返回 true（调用方据此放行）。
// 比较用 SHA-256 摘要 + subtle.ConstantTimeCompare：
//   - 常量时间，不因前缀匹配长度而泄露信息；
//   - 先摘要再比较，长度差异被吸收进摘要（不会因长度不同提前返回）；
//   - 摘要本身不可逆，即便有侧信道也拿不到密钥原文。
func VerifyBearer(r *http.Request, key string) bool {
	if key == "" {
		return true
	}
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, bearerPrefix) {
		// 缺头/方案不对：仍走一次摘要比较，保持耗时形状一致。
		subtle.ConstantTimeCompare(digest(""), digest(key))
		return false
	}
	tok := authz[len(bearerPrefix):]
	return subtle.ConstantTimeCompare(digest(tok), digest(key)) == 1
}

// ExtractToken 提取请求携带的凭证原文：优先 Authorization: Bearer，其次
// x-api-key（Anthropic/Claude Code 客户端的默认凭证头，ccswitch 场景必需）。
// 两者皆缺/为空返回 ("", false)。
func ExtractToken(r *http.Request) (string, bool) {
	if tok, ok := BearerToken(r); ok {
		return tok, true
	}
	if tok := strings.TrimSpace(r.Header.Get("x-api-key")); tok != "" {
		return tok, true
	}
	return "", false
}

// digest 返回 s 的 SHA-256（定长 32 字节，供常量时间比较）。
func digest(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// BearerToken 提取请求携带的 Bearer 凭证原文；缺头/方案不对返回 ("", false)。
func BearerToken(r *http.Request) (string, bool) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, bearerPrefix) {
		return "", false
	}
	tok := authz[len(bearerPrefix):]
	if tok == "" {
		return "", false
	}
	return tok, true
}

// VerifyAny 校验请求凭证是否命中 keys 中的任意一把（逐把常量时间比较）。
// keys 为空或全部为空串 = 未启用鉴权，恒返回 true。
func VerifyAny(r *http.Request, keys []string) bool {
	nonEmpty := false
	for _, k := range keys {
		if k != "" {
			nonEmpty = true
			break
		}
	}
	if !nonEmpty {
		return true
	}
	tok, ok := ExtractToken(r)
	if !ok {
		tok = "" // 仍走一轮比较保持耗时形状一致
	}
	d := digest(tok)
	matched := 0
	for _, k := range keys {
		if k == "" {
			continue
		}
		matched |= subtle.ConstantTimeCompare(d, digest(k))
	}
	return matched == 1
}
