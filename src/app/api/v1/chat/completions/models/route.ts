// 别名路由（对齐 Go handler.go:156-158）：客户端把完整聊天端点当 base_url 填时，
// SDK 拼出的模型列表路径会变成此变体。与端点本身方法不同（GET vs POST）不冲突，
// 直接按模型列表服务，省得 404 后让人误以为网关不支持（Railway 部署最常见报障）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { GET } from "@/app/api/v1/models/route";