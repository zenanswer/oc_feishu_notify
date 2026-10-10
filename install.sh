#!/usr/bin/env bash
# 部署 opencode 飞书通知插件到全局插件目录（symlink，方便源码迭代）
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME/.config/opencode/plugins"

mkdir -p "$DEST_DIR"

# feishu-notify.ts 是入口，detect.ts 是它相对导入的探测层，两个都要在
for f in feishu-notify.ts detect.ts; do
  SRC="$DIR/$f"
  DEST="$DEST_DIR/$f"

  if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "已存在非 symlink 的 $DEST，备份为 $DEST.bak"
    mv "$DEST" "$DEST.bak"
  fi

  ln -sfn "$SRC" "$DEST"
  echo "已部署: $DEST -> $SRC"
done

echo "重启 opencode 生效。"