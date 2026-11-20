import type { NextApiRequest, NextApiResponse } from "next";
import { isDirectLocalBootstrap, issueLocalPanelCookie, localPanelEnabled } from "@/lib/panel-local-session";

export const config = { api: { bodyParser: false } };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST" || !localPanelEnabled() || !isDirectLocalBootstrap({
    remoteAddress: req.socket.remoteAddress,
    localAddress: req.socket.localAddress,
    localPort: req.socket.localPort,
    headers: req.headers,
  })) {
    return res.status(404).end();
  }
  const cookie = issueLocalPanelCookie(req.headers.host);
  if (!cookie) return res.status(404).end();
  res.setHeader("Set-Cookie", cookie);
  return res.status(204).end();
}
