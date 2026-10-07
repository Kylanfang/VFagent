#!/usr/bin/env bash
# 重启隔离测试服务器（端口 8790，配置目录 .autotest）；可反复调用
cd "$(dirname "$0")/.." || exit 1
# 模型配置：用测试专用生成器覆盖 .autotest/model.json，保证每次回归的模型环境一致。
# 来历：该文件以前从不重置 —— 历史用例写入的脏 provider（w_jiagong_*/pwn 等）与"上游已下线的
# active 模型"会一直留在测试配置里，让 t-models/t-deep 长期出现与产品无关的假失败。
[ -f dev/make-autotest-model.mjs ] && node dev/make-autotest-model.mjs
for pid in $(netstat -ano 2>/dev/null | grep ":8790 " | grep LISTENING | awk '{print $5}' | sort -u); do
  taskkill //PID "$pid" //F >/dev/null 2>&1
done
sleep 1
VFLETCH_CONFIG_DIR="$PWD/.autotest" VFLETCH_PORT=8790 VFLETCH_HOST=127.0.0.1 VFLETCH_WORKSPACE="$PWD/.autotest/workspace" VFLETCH_REPORT_KEY=rep123 VFLETCH_IP_MAX_FAILS=100000 VFLETCH_MAX_FAILS=100 \
  nohup node server/main.mjs > .autotest/server.log 2>&1 &
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 2 http://127.0.0.1:8790/api/health | grep -q '"ok":true'; then
    echo "test server up (pid=$!) after ${i}s"
    exit 0
  fi
done
echo "test server failed to start"; tail -20 .autotest/server.log; exit 1
