#!/usr/bin/env bash
# 一键全量回归：先重启隔离测试服务器，再依次跑所有测试脚本；任一失败以非零退出
cd "$(dirname "$0")/.." || exit 1
bash dev/restart-test-server.sh || exit 1
fail=0
mkdir -p .autotest/logs
for t in dev/t-unit-guards.mjs dev/apitest.mjs dev/t-ui-undef.mjs dev/t-employee.mjs dev/t-secretary.mjs dev/t-audit-rbac.mjs dev/t-kb.mjs dev/t-mcp-discovery.mjs dev/t-sec-reverify.mjs dev/t-persist-check.mjs dev/t-trust-proxy.mjs dev/t-session-owner.mjs dev/t-admin-cov.mjs dev/t-hitl.mjs dev/t-soak.mjs dev/t-deep.mjs dev/t-relay.mjs dev/t-report-chain.mjs dev/t-resilience.mjs dev/t-multiuser.mjs dev/t-deadbind.mjs dev/t-race.mjs dev/t-migration.mjs dev/t-restart-stream.mjs dev/t-observer.mjs dev/t-models.mjs dev/t-think-split.mjs dev/t-stress.mjs; do
  echo "=================== $t"
  log=".autotest/logs/$(basename "$t" .mjs).log"
  node "$t" "$@" > "$log" 2>&1; rc=$?
  grep -E "❌|结果|Error|Timeout" "$log"
  [ $rc -ne 0 ] && fail=1
done
echo "=================== 全部完成 fail=$fail"
exit $fail
for _ in 1; do node dev/cleanup-autotest.mjs || true; done
