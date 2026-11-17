# 让 playwright 的 chromium 找到本地解压的系统库与浏览器本体。用法: source scripts/env.sh
_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export LD_LIBRARY_PATH="$_ROOT/.runtime/syslibs/usr/lib/x86_64-linux-gnu:$_ROOT/.runtime/syslibs/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PLAYWRIGHT_BROWSERS_PATH="$_ROOT/.runtime/ms-playwright"
