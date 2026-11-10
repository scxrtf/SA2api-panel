const fs = require("fs");
const env = fs.readFileSync(".env", "utf8");
const get = (k) => env.match(new RegExp("^" + k + '="?([^"\n]+)', "m"))[1];
const base = get("CLOUDBASE_POSTGREST_URL"), key = get("CLOUDBASE_API_KEY");
(async () => {
  for (const t of ["ModelHealthCheck", "UsageEvent", "RequestLog"]) {
    const col = t === "ModelHealthCheck" ? "checkedAt" : "at";
    const r = await fetch(`${base}/${t}?select=${col}&order=${col}.desc&limit=1`, {
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    const j = await r.json();
    const v = j[0]?.[col];
    console.log(t, "→", JSON.stringify(v), "| regex:", /^\d{4}-\d{2}-\d{2}T/.test(String(v)));
  }
})();
