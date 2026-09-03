#!/usr/bin/env bash
# 部署 opencode 飞书通知插件到全局插件目录（symlink，方便源码迭代）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/feishu-notify.ts"
DEST_DIR="$HOME/.config/opencode/plugins"
DEST="$DEST_DIR/feishu-notify.ts"

mkdir -p "$DEST_DIR"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "已存在非 symlink 的 $DEST，备份为 $DEST.bak"
  mv "$DEST" "$DEST.bak"
fi

ln -sfn "$SRC" "$DEST"
echo "已部署: $DEST -> $SRC"
echo "重启 opencode 生效。"
