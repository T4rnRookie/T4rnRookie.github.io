#!/bin/bash
# blog-sync: Watch ~/Documents/blog-drafts/ and auto sync to Hugo blog
#
# 用法:
#   1. 在 ~/Documents/blog-drafts/ 下新建文件夹，文件夹名就是文章 URL
#   2. 文件夹里放 index.md + 图片
#   3. 图片在 md 里用 ![描述](image.png) 引用
#   4. 脚本自动同步到博客并推送到 GitHub
#
# 目录结构示例:
#   ~/Documents/blog-drafts/
#   ├── my-first-post/
#   │   ├── index.md
#   │   ├── cover.png
#   │   └── screenshot.jpg
#   └── another-post.md          <-- 不带图片的文章直接放 .md 文件

DRAFTS_DIR="$HOME/Documents/blog-drafts"
BLOG_DIR="$HOME/Documents/blog"
POSTS_DIR="$BLOG_DIR/content/posts"
LOG_FILE="$HOME/.blog-sync.log"

export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

sync_posts() {
  local changed=0

  # 处理文件夹类型的文章 (带图片)
  for dir in "$DRAFTS_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name
    name="$(basename "$dir")"

    # 必须有 index.md
    if [ ! -f "$dir/index.md" ]; then
      # 如果有其他 .md 文件，重命名为 index.md
      local md_file
      md_file=$(find "$dir" -maxdepth 1 -name "*.md" | head -1)
      if [ -n "$md_file" ]; then
        mv "$md_file" "$dir/index.md"
        log "Renamed $(basename "$md_file") -> index.md in $name/"
      else
        continue
      fi
    fi

    # 检查是否有变化
    if [ -d "$POSTS_DIR/$name" ]; then
      if diff -rq "$dir" "$POSTS_DIR/$name" &>/dev/null; then
        continue
      fi
    fi

    # 同步整个文件夹
    mkdir -p "$POSTS_DIR/$name"
    rsync -a --delete "$dir" "$POSTS_DIR/$name/"
    log "Synced post: $name/ (with images)"
    changed=1
  done

  # 处理单独的 .md 文件 (不带图片)
  for md in "$DRAFTS_DIR"/*.md; do
    [ -f "$md" ] || continue
    local name
    name="$(basename "$md")"

    if [ -f "$POSTS_DIR/$name" ]; then
      if diff -q "$md" "$POSTS_DIR/$name" &>/dev/null; then
        continue
      fi
    fi

    cp "$md" "$POSTS_DIR/$name"
    log "Synced post: $name"
    changed=1
  done

  # 有变化就 commit + push
  if [ "$changed" -eq 1 ]; then
    cd "$BLOG_DIR" || return
    git add content/posts/
    git commit -m "sync: update posts $(date '+%Y-%m-%d %H:%M')"
    git push
    log "Pushed to GitHub"
  fi
}

# 首次同步
log "=== Blog sync started ==="
log "Watching: $DRAFTS_DIR"
sync_posts

# 监听文件变化
fswatch -o -r --event Created --event Updated --event Removed "$DRAFTS_DIR" | while read -r _; do
  sleep 2  # 等文件写完
  sync_posts
done
