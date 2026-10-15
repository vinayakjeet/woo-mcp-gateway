#!/usr/bin/env bash
# Store setup run by the store-bootstrap Helm hook Job on every install and upgrade,
# so every step must be safe to rerun. Never print secret values.
set -euo pipefail

: "${WP_HOME:?}" "${STORE_NAME:?}" "${WP_ADMIN_USER:?}" "${WP_ADMIN_PASSWORD:?}" \
  "${WP_ADMIN_EMAIL:?}" "${WC_CONSUMER_KEY:?}" "${WC_CONSUMER_SECRET:?}"

WP_PATH=/var/www/html
wp() { command wp --path="$WP_PATH" "$@"; }
set_option() { wp option update "$@" >/dev/null; }

# The WordPress pod writes wp-config.php on first boot, and MariaDB may still be starting.
deadline=$((SECONDS + 300))
until [ -f "$WP_PATH/wp-config.php" ] && php /usr/src/wordpress/healthz.php >/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "store-bootstrap: wp-config.php or database not ready after 300s" >&2
    exit 1
  fi
  sleep 5
done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$WP_HOME" --title="$STORE_NAME" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email >/dev/null
fi
set_option blogname "$STORE_NAME"

# The WooCommerce REST API needs pretty permalinks.
wp rewrite structure '/%postname%/' --hard >/dev/null 2>&1

# A killed install (helm uninstall --wait during crash recovery) leaves the wc_installing lock on
# the database volume, and WooCommerce takes a lock over only after 10 minutes. Every retry inside
# that window fails. An install takes seconds, so a lock older than 2 minutes is dead.
lock=$(wp option get wc_installing 2>/dev/null || true)
if [[ "$lock" =~ ^[0-9]+$ ]] && [ $(($(date +%s) - lock)) -gt 120 ]; then
  wp option delete wc_installing >/dev/null
  wp transient delete wc_installing >/dev/null 2>&1 || true
  echo "store-bootstrap: removed a stale WooCommerce install lock" >&2
fi

wp plugin activate woocommerce >/dev/null 2>&1
wp wc update >/dev/null

# WooCommerce creates its placeholder image once and never checks that the file still exists,
# so an attachment row that outlived its file (an older install path) shows a broken image.
wp eval '
$id = (int) get_option("woocommerce_placeholder_image");
$file = $id ? get_attached_file($id) : "";
if ($file && !file_exists($file)) {
  copy(WC()->plugin_path() . "/assets/images/placeholder-attachment.webp", $file)
    || WP_CLI::error("could not restore the WooCommerce placeholder image");
  require_once ABSPATH . "wp-admin/includes/image.php";
  wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, $file));
}'

set_option woocommerce_coming_soon no
set_option woocommerce_store_pages_only no
set_option woocommerce_currency INR
set_option woocommerce_default_country IN:KA
set_option timezone_string Asia/Kolkata
# "disabled" removes the shipping step from checkout.
set_option woocommerce_ship_to_countries disabled
set_option woocommerce_calc_taxes no
set_option woocommerce_enable_guest_checkout yes
set_option woocommerce_onboarding_profile '{"skipped":true}' --format=json
# WooCommerce 10 rejects updates to the old woocommerce_task_list_hidden/complete options.
set_option woocommerce_task_list_hidden_lists '["setup","extended"]' --format=json
set_option woocommerce_task_list_completed_lists '["setup"]' --format=json

wp wc tool run install_pages --user=1 >/dev/null

# The homepage is the shop, not WordPress's default blog.
set_option show_on_front page
set_option page_on_front "$(wp option get woocommerce_shop_page_id)"

set_option woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

# The brief forbids WooCommerce's built-in MCP server; the gateway uses our own woo-mcp.
set_option woocommerce_feature_mcp_integration_enabled no
mcp_feature=$(wp option get woocommerce_feature_mcp_integration_enabled)
if [ "$mcp_feature" != no ]; then
  echo "store-bootstrap: WooCommerce MCP feature is enabled" >&2
  exit 1
fi

wp eval-file /opt/store/create-api-key.php

product_count() { wp post list --post_type=product --post_status=any --format=count; }
if [ "$(product_count)" -eq 0 ]; then
  wp wc product create --user=1 --name="Filter Coffee 250g" --regular_price=450 --status=publish --porcelain >/dev/null
  wp wc product create --user=1 --name="Masala Chai 100g" --regular_price=220 --status=publish --porcelain >/dev/null
  wp wc product create --user=1 --name="Steel Tumbler Set" --regular_price=799 --status=publish --porcelain >/dev/null
fi

cod=$(wp option pluck woocommerce_cod_settings enabled)
echo "store-bootstrap: ok url=$WP_HOME products=$(product_count) cod=$cod mcp_feature=$mcp_feature"
