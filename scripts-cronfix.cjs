const fs = require("fs");
let cron = fs.readFileSync("src/lib/cron.ts", "utf8");

// 1) 顶部 import 补 AppConfig
cron = cron.replace(
  'import { prisma } from "./db";',
  'import { prisma } from "./db";\nimport type { AppConfig } from "./config";'
);

// 2) 直接顶部导入 taskcenter 与 report（去掉动态 import 与畸形 helper）
cron = cron.replace(
  'import { isAlreadyCheckin } from "./upstream/errors";',
  'import { isAlreadyCheckin } from "./upstream/errors";\n' +
  'import { reportChatActivity } from "./upstream/report";\n' +
  'import {\n' +
  '  buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,\n' +
  '} from "./upstream/tasks";\n' +
  'import { listActiveAccounts, reportGapMs } from "./taskcenter";'
);

// 3) 删除追加段里错误的重复 import 与 helper
cron = cron.replace(/import \{\s*\r?\n\s*buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,\s*\r?\n\s*\} from "\.\/upstream\/tasks";\s*\r?\nimport \{ reportGapMs \} from "\.\/taskcenter";/, "");
cron = cron.replace(/function aAuth\(row: \{ auth: AuthShape \}\): AuthShape \{ return row\.auth; \}\s*\r?\n?/, "");
cron = cron.replace(/\s*const \{ reportChatActivity \} = await import\("\.\/upstream\/report"\);\s*\r?\n\s*await reportChatActivity\(cfg, a,/, "\n    await reportChatActivity(cfg, a,");
cron = cron.replace(/\s*const \{ listActiveAccounts \} = await import\("\.\/taskcenter"\);\s*\r?\n/g, "\n");
cron = cron.replace(/\s*const \{ reportChatActivity \} = await import\("\.\/upstream\/report"\);\s*\r?\n\s*await reportChatActivity\(cfg, aAuth\(row\),/, "\n    await reportChatActivity(cfg, row.auth,");

fs.writeFileSync("src/lib/cron.ts", cron, "utf8");
console.log("cron.ts fixed");
