const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const fs = require("fs");
const url = fs.readFileSync(".env", "utf8").match(/DATABASE_URL="(.+)"/)[1];
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
p.account.count()
  .then((n) => { console.log("6543 pooler query OK, account count =", n); return p.$disconnect(); })
  .catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
