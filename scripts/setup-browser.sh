#!/usr/bin/env bash
# 准备 Chromium 运行环境（无需 root）：
# 1. 下载并解压 Chromium 所需的系统共享库到 .runtime/syslibs
# 2. 下载 playwright 的 chromium-headless-shell
# 幂等：已存在的步骤会跳过。
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME_DIR=.runtime/syslibs
export LD_LIBRARY_PATH="$PWD/$RUNTIME_DIR/usr/lib/x86_64-linux-gnu:$PWD/$RUNTIME_DIR/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if [ ! -d "$RUNTIME_DIR/usr/lib/x86_64-linux-gnu" ]; then
  echo "==> 下载系统共享库 (.deb) 到 $RUNTIME_DIR"
  mkdir -p .runtime/debs .runtime/apt-lists/partial .runtime/apt-cache/archives/partial
  APT_OPTS=(-o Dir::State::Lists="$PWD/.runtime/apt-lists" -o Dir::Cache="$PWD/.runtime/apt-cache" -o Dir::State::status=/var/lib/dpkg/status)
  apt-get "${APT_OPTS[@]}" update
  (cd .runtime/debs && apt-get "${APT_OPTS[@]}" download \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libdbus-1-3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgbm1 libxkbcommon0 libasound2 libxrender1 libdrm2 \
    libwayland-server0 libxau6 libxdmcp6 libxi6 libbsd0 libmd0 \
    libfontconfig1 fonts-dejavu-core libfreetype6 libpng16-16 libbrotli1 \
    fonts-wqy-microhei)
  for f in .runtime/debs/*.deb; do dpkg-deb -x "$f" "$RUNTIME_DIR"; done
fi

if ! npx playwright-core --version >/dev/null 2>&1; then
  echo "==> 安装 npm 依赖"
  npm install
fi

echo "==> 下载 chromium-headless-shell 到 .runtime/ms-playwright（~/.cache 会被清理，不用默认位置）"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.runtime/ms-playwright"
npx playwright-core install chromium-headless-shell

echo "==> 校验浏览器可启动"
node -e '
import("playwright-core").then(async ({ chromium }) => {
  const b = await chromium.launch();
  await b.close();
  console.log("浏览器 OK");
})'

echo "完成。运行 demo 前请先: source scripts/env.sh"
