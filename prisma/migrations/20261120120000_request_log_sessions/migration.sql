ALTER TABLE public."RequestLog" ADD COLUMN IF NOT EXISTS "sessionId" TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "RequestLog_sessionId_at_id_idx" ON public."RequestLog" ("sessionId", "at", "id");

-- One filtered scope for both the collapsed summaries and the expanded request IDs.
-- Only those IDs from an expanded page are subsequently read as ordinary log rows.
CREATE OR REPLACE FUNCTION public.wb2_request_log_session_page(
  p_filters jsonb, p_from timestamp, p_to timestamp, p_limit integer, p_offset integer, p_group text, p_storage_zone text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $sql$
  WITH filtered AS (
    SELECT id, at, model, "keyName", "sessionId",
           (status >= 400 OR "errKind" <> '') AS failed,
           GREATEST(0, "cacheHitTok") AS hit, GREATEST(0, "cacheMissTok") AS miss
    FROM public."RequestLog"
    -- Prisma stores UTC wall time; this project's CloudBase gateway stores Shanghai wall time.
    -- Translate the bounds, not the indexed column, and return an offset-bearing latest time.
    WHERE at >= (p_from AT TIME ZONE 'UTC' AT TIME ZONE p_storage_zone)
      AND at <= (p_to AT TIME ZONE 'UTC' AT TIME ZONE p_storage_zone)
      AND (p_group IS NULL
        OR (left(p_group, 2) = 's:' AND "sessionId" = substr(p_group, 3))
        OR (left(p_group, 2) = 'r:' AND id = substr(p_group, 3) AND "sessionId" = ''))
      AND starts_with(uid, COALESCE(p_filters->>'account', ''))
      AND starts_with(model, COALESCE(p_filters->>'model', ''))
      AND starts_with("keyName", COALESCE(p_filters->>'key', ''))
      AND strpos("clientIp", COALESCE(p_filters->>'client_ip', '')) > 0
      AND strpos(ua, COALESCE(p_filters->>'user_agent', '')) > 0
      AND strpos(lower("errMsg"), lower(COALESCE(p_filters->>'err', ''))) > 0
      AND CASE p_filters->>'outcome'
        WHEN 'ok' THEN status < 400 AND "errKind" = ''
        WHEN 'error' THEN status >= 400 OR "errKind" <> ''
        ELSE TRUE
      END
  ), groups AS (
    SELECT CASE WHEN "sessionId" = '' THEN 'r:' || id ELSE 's:' || "sessionId" END AS id,
           max(at) AS last_at, count(*) AS count, count(*) FILTER (WHERE failed) AS failed,
           count(DISTINCT NULLIF(model, '')) AS "modelCount", max(model) AS model,
           max("keyName") AS "keyName", sum(hit) AS "cacheHitTok", sum(miss) AS "cacheMissTok",
           count(*) FILTER (WHERE hit > 0 OR miss > 0) AS reported
    FROM filtered GROUP BY 1
  )
  SELECT CASE WHEN p_group IS NULL THEN (
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM groups),
      'entries', COALESCE(jsonb_agg(to_jsonb(page) - 'last_at' ORDER BY last_at DESC, id DESC), '[]'::jsonb)
    )
    FROM (
      SELECT *, last_at AT TIME ZONE p_storage_zone AS "lastAt" FROM groups
      ORDER BY last_at DESC, id DESC LIMIT LEAST(100, GREATEST(1, p_limit)) OFFSET GREATEST(0, p_offset)
    ) AS page
  ) ELSE (
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'entries', COALESCE(jsonb_agg(id ORDER BY at DESC, id DESC), '[]'::jsonb)
    )
    FROM (
      SELECT id, at FROM filtered ORDER BY at DESC, id DESC
      LIMIT LEAST(100, GREATEST(1, p_limit)) OFFSET GREATEST(0, p_offset)
    ) AS page
  ) END
$sql$;

REVOKE EXECUTE ON FUNCTION public.wb2_request_log_session_page(jsonb, timestamp, timestamp, integer, integer, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.wb2_request_log_session_page(jsonb, timestamp, timestamp, integer, integer, text, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.wb2_request_log_session_page(jsonb, timestamp, timestamp, integer, integer, text, text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.wb2_request_log_session_page(jsonb, timestamp, timestamp, integer, integer, text, text) TO service_role;
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
