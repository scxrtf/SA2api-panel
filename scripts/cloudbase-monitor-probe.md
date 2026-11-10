# CloudBase 平台指标探活

脚本：`scripts/cloudbase-monitor-probe.mjs`。只调用腾讯云只读 API，不写数据库，不修改 CloudBase 资源。

1. 在腾讯云 CAM 创建 API 密钥，建议绑定最小只读策略（CloudBase 只读 + 云监控只读）。
2. 在本机 `.env` 增加：

   ```dotenv
   CLOUDBASE_SECRET_ID=<CAM_SECRET_ID>
   CLOUDBASE_SECRET_KEY=<CAM_SECRET_KEY>
   ```

3. 运行 `node scripts/cloudbase-monitor-probe.mjs`。

脚本探活 `DescribeEnvs`、`DescribeCurveData(EnvQPSAll)`、`DescribeQuotaData(DbSizepkg)` 和 `DescribeCurveData(MysqlDbConnections)`。个人版共享 PG 不开放容量/连接数时，监控页仅接入实际返回的环境 QPS，容量继续使用采样估算。
