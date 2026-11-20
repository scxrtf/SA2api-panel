CREATE TABLE public."GatewayResponse" (
    "id" TEXT PRIMARY KEY,
    "backend" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "GatewayResponse_createdAt_idx" ON public."GatewayResponse" ("createdAt");
ALTER TABLE public."GatewayResponse" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."GatewayResponse" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public."GatewayResponse" FROM anon;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public."GatewayResponse" FROM authenticated;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."GatewayResponse" TO service_role;
        CREATE POLICY "gateway_response_service" ON public."GatewayResponse" TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
