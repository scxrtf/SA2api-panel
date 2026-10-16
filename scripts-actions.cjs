const fs = require("fs");
const content = String.raw`
// 任务动作实现（占位骨架；移植 internal/panel/autotask.go 的 run* 函数）。
// 依赖桌面/MP 事件构造器与真实 chat 链路（upstream/report.go、events_desktop.go、
// events_mp.go、chat.go，合计约 500KB Go 源码），属 P4 深水区，需真实账号联调校正。
// 当前行为：返回「待实装」说明（nil 错误 = 业务跳过，不进队列 error 列）。
// 高频低风险动作（chat_5/first_buddy/model chat 等）将优先在此实装。
import type { AppConfig } from "./config";
import type { AuthShape } from "./upstream/client";

const TODO = (what: string) =>
  "动作「" + what + "」尚未在 Next.js 版实装（依赖上游桌面/小程序事件构造器与真实对话链路，P4 待移植）";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const notImplemented = (what: string) => async (_cfg: AppConfig, _a: AuthShape): Promise<string> => TODO(what);

export const runChat5 = notImplemented("chat_5 对话活跃事件上报");
export const runFirstBuddy = notImplemented("first_buddy 领养 Buddy");
export const runModelChat = notImplemented("Model_chat_GLM5.2 真实对话");
export const runRichMeow = notImplemented("RichMeow_Chat 桌面指纹事件链");
export const runBuddyApp = notImplemented("Buddy_App 应用进入事件链");
export const runAutomationCreate = notImplemented("automation_1 定时任务创建事件");
export const runLibraryRead = notImplemented("Library_read 资料库阅读事件");
export const runTemplateUse = notImplemented("template_5 模板使用事件组");
export const runPlaybookPrompt = notImplemented("playbook_prompt 灵感 Prompt 事件组");
export const runCreateCanvas = notImplemented("create_canvas 画布创建事件组");
export const runExpertUse = notImplemented("expert_5 专家召唤+使用链");
export const runExpertTeamUse = notImplemented("Expert_team_use_3 专家团召唤+使用链");
export const runAppearance = notImplemented("Hp_Appearance 主题皮肤事件");
export const runSkillFresh = notImplemented("skill_1 技能加载事件");
export const runExpertLighthouse = notImplemented("Expert_lighthouse 轻量云专家链");
export const runBlackCat = notImplemented("black_cat 夜间对话补足");
export const runSchoolSeason = notImplemented("school_season 校园日（mp）");
export const runSequentialChat = notImplemented("Sequential_Tasks_1 小程序首对话");
export const runMiniExpert = notImplemented("Sequential_Tasks_2 小程序选专家对话");
export const runSequentialChat5 = notImplemented("Sequential_Tasks_3 小程序五次对话");
export const runSequentialAutomation = notImplemented("Sequential_Tasks_4 小程序定时任务");
export const runSequentialModelChat = notImplemented("Sequential_Tasks_5 小程序 GLM5.2");
export const runSequentialChat10 = notImplemented("Sequential_Tasks_6 小程序十次对话");
export const runSequentialPlaybook = notImplemented("Sequential_Tasks_7 小程序灵感功能");
`;
fs.writeFileSync("src/lib/autotask-actions.ts", content.trimStart(), "utf8");
console.log("written", content.length);
