// Package tz 统一业务时间锚点：北京时间（UTC+8，无夏令时）。
//
// 为什么需要：网关在 Railway/容器部署时宿主机时区通常是 UTC，而上游
// CodeBuddy 的自然日口径（签到/旅行/积分到期/优惠窗口/夜猫子）全部按
// Asia/Shanghai 计。若这些路径用 time.Local，容器里会整体跑偏 8 小时
// （9 点签到变成 17 点）。统一经 Beijing 取时区，业务时间不再随宿主机
// 漂移；同时消除各处散落的私有 FixedZone（travel/degrade/upstream promo），
// 改一处即全改。
//
// 用 FixedZone 而非 LoadLocation("Asia/Shanghai")：Windows 无 IANA tzdata
// 时 LoadLocation 会失败；中国自 1991 年起无夏令时，固定 +8 偏移正确。
package tz

import "time"

// Beijing 北京时间（UTC+8）。所有按"自然日/几点钟"计的业务逻辑统一用它。
var Beijing = time.FixedZone("CST", 8*3600)

// Now 返回当前时刻（北京时区视图）。等价 time.Now().In(Beijing)，
// 只是少一次重复书写且意图自明。
func Now() time.Time { return time.Now().In(Beijing) }
