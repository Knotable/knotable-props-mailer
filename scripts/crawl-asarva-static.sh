#!/usr/bin/env bash
# =============================================================================
# crawl-asarva-static.sh
#
# Creates a complete, self-contained static mirror of https://a.sarva.co
# that can be dropped directly into an nginx/Apache/S3 docroot and served
# as-is — no PHP, no database required.
#
# What it does:
#   1. Uses wget --mirror to recursively crawl every page, post, image,
#      CSS, JS and font file on the site.
#   2. Rewrites every internal absolute URL to a relative path so the
#      snapshot works regardless of the domain it is served from.
#   3. Ensures every directory has an index.html so clean /slug/ URLs work.
#   4. Removes WordPress-only paths (wp-admin, wp-login, xmlrpc, cron)
#      so they 404 cleanly instead of hitting a dead PHP backend.
#   5. Produces a ready-to-deploy folder: ./a.sarva.co-static/
#
# Requirements:  wget, python3  (both standard on macOS/Linux)
#                On macOS:  brew install wget   (if not already present)
#
# Usage:
#   chmod +x crawl-asarva-static.sh
#   ./crawl-asarva-static.sh
#
#   To resume an interrupted crawl:
#   ./crawl-asarva-static.sh --resume
#
# After it finishes, test locally:
#   cd a.sarva.co-static
#   python3 -m http.server 8080
#   open http://localhost:8080
#
# To deploy to an S3 static site:
#   aws s3 sync ./a.sarva.co-static/ s3://YOUR-BUCKET-NAME/ \
#     --delete --acl public-read \
#     --cache-control "max-age=86400"
#
# To deploy to an existing nginx server (replaces /var/www/html or similar):
#   rsync -av --delete ./a.sarva.co-static/ user@your-server:/var/www/a.sarva.co/
# =============================================================================

set -euo pipefail

SITE="https://a.sarva.co"
DOMAIN="a.sarva.co"
OUTPUT_DIR="${DOMAIN}-static"
RESUME="${1:-}"

# ── colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── preflight checks ───────────────────────────────────────────────────────────
if ! command -v wget &>/dev/null; then
  error "wget not found. Install it with:  brew install wget"
  exit 1
fi
if ! command -v python3 &>/dev/null; then
  error "python3 not found. Please install Python 3."
  exit 1
fi

info "Starting static mirror of ${SITE}"
info "Output directory: ./${OUTPUT_DIR}"
echo ""

# ── step 1: wget mirror crawl ──────────────────────────────────────────────────
#
# Key flags explained:
#   --mirror              = recursive + timestamps + infinite depth + no-remove-listing
#   --convert-links       = rewrite internal links to relative paths (post-crawl)
#   --adjust-extension    = add .html to pages served without extension
#   --page-requisites     = grab CSS, JS, images needed to render each page
#   --no-parent           = don't crawl above a.sarva.co/
#   --wait=0.5            = 500ms between requests — polite, avoids rate limiting
#   --random-wait         = randomise wait ±50% to look more human
#   --tries=3             = retry failed downloads 3× before giving up
#   --timeout=30          = 30s per request timeout
#   --reject-regex        = skip WordPress dynamic/admin URLs that make no sense static
#   --exclude-domains     = don't follow links off-site (gravatar, wp.com CDN etc.)
#   --user-agent          = identify as a crawler (honest), avoids some bot blocks
#   -e robots=off         = ignore robots.txt (we own the site)
#
info "Phase 1: Crawling with wget..."

WGET_OPTS=(
  --mirror
  --convert-links
  --adjust-extension
  --page-requisites
  --no-parent
  --no-verbose
  --show-progress
  --wait=0.5
  --random-wait
  --tries=3
  --timeout=30
  --user-agent="StaticMirrorBot/1.0 (site owner crawl)"
  -e robots=off
  # Skip WordPress dynamic/admin endpoints
  --reject-regex="(wp-login|wp-admin|wp-cron|wp-comments-post|xmlrpc|/feed/?$|/feed/atom|/comments/feed|/wp-json/wp/v2/|preview=true|\?replytocom|\?p=[0-9])"
  # Skip off-domain assets that don't need to be local
  --exclude-domains="gravatar.com,wordpress.com,wp.com,akismet.com,stats.wordpress.com,pixel.wp.com"
  # Keep only these file types in --page-requisites pulls
  --accept="html,htm,css,js,jpg,jpeg,png,gif,webp,svg,ico,woff,woff2,ttf,eot,otf,xml,txt"
)

if [[ "${RESUME}" == "--resume" ]]; then
  WGET_OPTS+=(--continue)
  info "Resuming previous crawl..."
fi

# Run wget. It creates a directory named after the domain.
wget "${WGET_OPTS[@]}" "${SITE}/" || true   # '|| true' — wget exits non-zero on
                                             # minor errors (404s etc.); we handle
                                             # those in cleanup below.

echo ""
info "Phase 1 complete. Raw mirror in: ./${DOMAIN}/"

# ── step 2: rename the wget output folder to our output dir ───────────────────
if [[ -d "${DOMAIN}" && "${DOMAIN}" != "${OUTPUT_DIR}" ]]; then
  rm -rf "${OUTPUT_DIR}"
  mv "${DOMAIN}" "${OUTPUT_DIR}"
fi

# ── step 3: ensure every directory has an index file ──────────────────────────
#
# wget --adjust-extension may produce:
#   about/index.html   (good)
#   about.html         (also fine — nginx will serve this for /about/)
#
# But some slug directories may only have "about" (no extension) if the server
# returned the page without a Content-Type extension cue. This step covers that.
#
info "Phase 2: Ensuring every directory has an index.html..."

python3 - "${OUTPUT_DIR}" <<'PYEOF'
import os, sys, shutil

root = sys.argv[1]
renamed = 0

for dirpath, dirnames, filenames in os.walk(root):
    # Skip WordPress asset directories — no index needed
    skip = ('wp-content', 'wp-includes', 'wp-json', 'feed')
    if any(s in dirpath for s in skip):
        continue

    has_index = any(f in ('index.html', 'index.htm') for f in filenames)
    if has_index:
        continue

    # Look for a file whose name matches the last path component (wget creates
    # e.g. /about/about.html or just /about.html at the parent level)
    dirname = os.path.basename(dirpath)
    candidate = None
    for f in filenames:
        base = os.path.splitext(f)[0]
        if base == dirname or base == 'index':
            candidate = os.path.join(dirpath, f)
            break

    if candidate:
        dest = os.path.join(dirpath, 'index.html')
        shutil.copy2(candidate, dest)
        renamed += 1

print(f"  Created {renamed} index.html stubs for clean URL directories.")
PYEOF

# ── step 4: fix absolute internal URLs that wget missed ───────────────────────
#
# wget --convert-links rewrites most links, but sometimes misses:
#   - URLs in inline <style> blocks
#   - URLs in JS strings
#   - srcset attributes
#   - Open Graph / Twitter card meta tags
#
# This Python pass does a final sweep over every .html file.
#
info "Phase 3: Rewriting any remaining absolute internal URLs..."

python3 - "${OUTPUT_DIR}" "${DOMAIN}" <<'PYEOF'
import os, sys, re

root    = sys.argv[1]
domain  = sys.argv[2]
pattern = re.compile(rf'https?://{re.escape(domain)}', re.IGNORECASE)
fixed   = 0
files   = 0

for dirpath, _, filenames in os.walk(root):
    for fname in filenames:
        if not fname.endswith(('.html', '.htm', '.css', '.js')):
            continue
        fpath = os.path.join(dirpath, fname)
        try:
            with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception:
            continue

        new_content = pattern.sub('', content)
        if new_content != content:
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            fixed += 1
        files += 1

print(f"  Scanned {files} files, rewrote absolute URLs in {fixed}.")
PYEOF

# ── step 5: remove WordPress-only paths ───────────────────────────────────────
#
# Even though we didn't crawl them, wget may have grabbed wp-login.php,
# wp-cron.php etc. as "page requisites". Remove them — they don't belong
# in a static mirror and would be confusing.
#
info "Phase 4: Removing WordPress-only server-side files..."

WP_REMOVE=(
  "${OUTPUT_DIR}/wp-login.php"
  "${OUTPUT_DIR}/wp-login.php.html"
  "${OUTPUT_DIR}/xmlrpc.php"
  "${OUTPUT_DIR}/xmlrpc.php.html"
  "${OUTPUT_DIR}/wp-cron.php"
  "${OUTPUT_DIR}/wp-trackback.php"
  "${OUTPUT_DIR}/wp-comments-post.php"
)
for f in "${WP_REMOVE[@]}"; do
  [[ -e "$f" ]] && rm -f "$f" && info "  Removed: $f"
done

# ── step 6: generate a minimal .htaccess for Apache ───────────────────────────
#
# If you're serving from Apache (common on AWS EC2 LAMP stacks), this
# .htaccess enables clean URLs (no .html extension) and a custom 404 page.
# Harmless on nginx (just ignored).
#
info "Phase 5: Writing .htaccess for Apache clean URLs..."

cat > "${OUTPUT_DIR}/.htaccess" <<'HTACCESS'
# Static WordPress mirror — Apache config
# Enables clean /slug/ URLs without .html extension visible in browser.

Options -Indexes
Options +FollowSymLinks

# Serve pre-compressed assets if available
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/css application/javascript
</IfModule>

# Cache headers for static assets
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresByType image/jpeg "access plus 1 year"
    ExpiresByType image/png  "access plus 1 year"
    ExpiresByType image/webp "access plus 1 year"
    ExpiresByType image/gif  "access plus 1 year"
    ExpiresByType image/svg+xml "access plus 1 year"
    ExpiresByType text/css   "access plus 1 month"
    ExpiresByType application/javascript "access plus 1 month"
    ExpiresByType application/x-font-woff "access plus 1 year"
    ExpiresByType application/font-woff2  "access plus 1 year"
</IfModule>

<IfModule mod_rewrite.c>
    RewriteEngine On

    # If a directory exists with an index.html, serve it
    RewriteCond %{REQUEST_FILENAME} -d
    RewriteCond %{REQUEST_FILENAME}/index.html -f
    RewriteRule ^(.*)/?$ $1/index.html [L]

    # If the exact file exists, serve it directly
    RewriteCond %{REQUEST_FILENAME} -f
    RewriteRule ^ - [L]

    # Try slug.html, then slug/index.html
    RewriteCond %{REQUEST_FILENAME}.html -f
    RewriteRule ^(.+?)/?$ $1.html [L]

    RewriteCond %{REQUEST_FILENAME}/index.html -f
    RewriteRule ^(.+?)/?$ $1/index.html [L]

    # Everything else → 404
    RewriteRule ^ - [R=404,L]
</IfModule>

# Custom 404 — create a 404.html in the root if you want a nice page
ErrorDocument 404 /404.html
HTACCESS

# ── step 7: generate an nginx config snippet ──────────────────────────────────
info "Phase 6: Writing nginx config snippet..."

cat > "${OUTPUT_DIR}/../nginx-a-sarva-co.conf" <<NGINXCONF
# nginx config for a.sarva.co static mirror
# Place in /etc/nginx/sites-available/a.sarva.co and symlink to sites-enabled/
# Replace /var/www/a.sarva.co with wherever you put the mirror folder.

server {
    listen 80;
    listen [::]:80;
    server_name a.sarva.co www.a.sarva.co;

    # Redirect HTTP → HTTPS (remove this block if not using SSL)
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name a.sarva.co www.a.sarva.co;

    root /var/www/a.sarva.co;
    index index.html index.htm;

    # SSL — adjust paths to your cert files
    # ssl_certificate     /etc/letsencrypt/live/a.sarva.co/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/a.sarva.co/privkey.pem;

    # Clean URLs: try /slug/index.html then /slug.html then 404
    location / {
        try_files \$uri \$uri/index.html \$uri.html =404;
    }

    # Block WordPress endpoints that no longer exist
    location ~* ^/(wp-login|wp-admin|wp-cron|xmlrpc|wp-comments-post) {
        return 410;
    }

    # Long cache for static assets
    location ~* \.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff|woff2|ttf|eot)\$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Gzip
    gzip on;
    gzip_types text/html text/css application/javascript image/svg+xml;
    gzip_min_length 1024;

    error_page 404 /404.html;
}
NGINXCONF

# ── step 8: print summary ──────────────────────────────────────────────────────
echo ""
info "═══════════════════════════════════════════════════════"
info "Mirror complete!"
echo ""

TOTAL_FILES=$(find "${OUTPUT_DIR}" -type f | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "${OUTPUT_DIR}" | cut -f1)
HTML_COUNT=$(find "${OUTPUT_DIR}" -name "*.html" | wc -l | tr -d ' ')

info "  Output folder : ./${OUTPUT_DIR}/"
info "  Total files   : ${TOTAL_FILES}"
info "  Total size    : ${TOTAL_SIZE}"
info "  HTML pages    : ${HTML_COUNT}"
echo ""
info "Next steps:"
echo "  1. Test locally:"
echo "       cd ${OUTPUT_DIR} && python3 -m http.server 8080"
echo "       open http://localhost:8080"
echo ""
echo "  2a. Deploy to S3 (static website hosting):"
echo "       aws s3 sync ./${OUTPUT_DIR}/ s3://YOUR-BUCKET/ \\"
echo "         --delete --acl public-read --cache-control 'max-age=86400'"
echo ""
echo "  2b. Deploy to EC2 nginx (replaces WordPress docroot):"
echo "       rsync -av --delete ./${OUTPUT_DIR}/ user@your-ec2:/var/www/a.sarva.co/"
echo "       # then: sudo cp nginx-a-sarva-co.conf /etc/nginx/sites-available/a.sarva.co"
echo "       # then: sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "  2c. Deploy to EC2 Apache (replaces WordPress docroot):"
echo "       rsync -av --delete ./${OUTPUT_DIR}/ user@your-ec2:/var/www/html/"
echo "       # .htaccess is already in the folder"
echo ""
info "═══════════════════════════════════════════════════════"
