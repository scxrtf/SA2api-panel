const fs = require("fs");
let t = fs.readFileSync("src/app/api/panel/models/test/route.ts", "utf8");
t = t.replace(
  '{ conversationRequestID: "modeltest:" + testID },',
  '{ conversationID: "modeltest-" + testID, conversationRequestID: "modeltest:" + testID, traceID: "modeltest:" + testID },\n      controller.signal,'
);
t = t.replace('res.body.slice(0, 300)', '(res.respBody ?? "").slice(0, 300)');
t = t.replace('if (!res.stream) return fail(502, "upstream returned no stream");\n    const r = await consumeSSE(res.stream, controller.signal);',
  'if (!res.body) return fail(502, "upstream returned no stream");\n    const r = await consumeSSE(res.body, controller.signal);');
fs.writeFileSync("src/app/api/panel/models/test/route.ts", t, "utf8");
console.log("fixed");
