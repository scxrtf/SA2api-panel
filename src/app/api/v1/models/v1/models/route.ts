// 别名路由：客户端把完整模型目录端点当 base_url 填时，
// OpenAI SDK 会再追加 /v1/models；与既有聊天/消息别名同口径。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { GET } from "@/app/api/v1/models/route";
