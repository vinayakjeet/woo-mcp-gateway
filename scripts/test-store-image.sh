#!/usr/bin/env bash
# Tests the store-wordpress image with docker only. Build it first: docker build -t store-wordpress:dev images/store-wordpress
set -euo pipefail

IMAGE=${IMAGE:-store-wordpress:dev}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

in_image() { docker run --rm --entrypoint sh "$IMAGE" -c "$1"; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE not found"

[ "$(in_image 'wp --version')" = "WP-CLI 2.12.0" ] || fail "wp-cli 2.12.0"
pass "wp-cli 2.12.0"

in_image "grep -q 'Version: 10.9.4' /usr/src/wordpress/wp-content/plugins/woocommerce/woocommerce.php" || fail "woocommerce 10.9.4"
pass "woocommerce 10.9.4 in /usr/src/wordpress"

in_image 'test -f /usr/src/wordpress/healthz.php && test -x /opt/store/bootstrap.sh && test -f /opt/store/create-api-key.php' || fail "store files"
pass "store files present"

[ "$(in_image 'id -u')" = "33" ] || fail "default uid 33"
pass "default uid 33"

in_image "grep -qx 'Listen 8080' /etc/apache2/ports.conf && ! grep -qx 'Listen 80' /etc/apache2/ports.conf && grep -q '<VirtualHost \*:8080>' /etc/apache2/sites-available/000-default.conf" || fail "apache on 8080"
pass "apache listens on 8080"

# Runtime tests use throwaway containers on a private network. The password is not a secret.
NET=store-image-test
DB_PW=test-only-password
PORT=${PORT:-18080}

cleanup() {
  docker rm -f sit-db sit-wp >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null

start_db() {
  docker run -d --name sit-db --network "$NET" \
    -e MARIADB_ROOT_PASSWORD="$DB_PW" -e MARIADB_DATABASE=wordpress \
    -e MARIADB_USER=wordpress -e MARIADB_PASSWORD="$DB_PW" \
    mariadb:11.4.13 >/dev/null
}

docker run -d --name sit-wp --network "$NET" -p "127.0.0.1:$PORT:8080" \
  -e WORDPRESS_DB_HOST=sit-db:3306 -e WORDPRESS_DB_NAME=wordpress \
  -e WORDPRESS_DB_USER=wordpress -e WORDPRESS_DB_PASSWORD="$DB_PW" \
  -e HOME=/tmp \
  "$IMAGE" >/dev/null

code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz.php" || true; }
wait_code() {
  local want=$1 got=""
  for _ in $(seq 60); do
    got=$(code)
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  fail "healthz.php expected $want, last got $got"
}

wait_code 503
pass "healthz.php 503 without a database"

# The Ingress sends Host without a port, so Apache must not fill in its own 8080.
loc=$(curl -sI -H "Host: shop.test" "http://127.0.0.1:$PORT/wp-admin" | tr -d '\r' | grep -i '^location:' || true)
[ "$loc" = "Location: http://shop.test/wp-admin/" ] || fail "wp-admin redirect: $loc"
pass "directory redirect has no :8080"

start_db
wait_code 200
pass "healthz.php 200 on an empty, uninstalled database"

docker stop sit-db >/dev/null
wait_code 503
pass "healthz.php 503 after the database stops"
docker start sit-db >/dev/null
wait_code 200

# Fixed test keys in the ck_/cs_ + 40 hex format. Not secrets.
TEST_CK=ck_$(printf 'a%.0s' $(seq 40))
TEST_CS=cs_$(printf 'b%.0s' $(seq 40))
TEST_TITLE="Asha's Shop, Pune"

run_bootstrap() {
  docker exec \
    -e WP_HOME="http://127.0.0.1:$PORT" -e STORE_NAME="$TEST_TITLE" \
    -e WP_ADMIN_USER=admin -e WP_ADMIN_PASSWORD=test-only-password \
    -e WP_ADMIN_EMAIL=admin@example.com \
    -e WC_CONSUMER_KEY="$TEST_CK" -e WC_CONSUMER_SECRET="$TEST_CS" \
    sit-wp /opt/store/bootstrap.sh 2>&1 | tail -1
}
wpc() { docker exec sit-wp wp --path=/var/www/html "$@"; }

for run in 1 2; do
  line=$(run_bootstrap || true)
  [ "$line" = "store-bootstrap: ok url=http://127.0.0.1:$PORT products=3 cod=yes mcp_feature=no" ] \
    || fail "bootstrap run $run summary: $line"
  pass "bootstrap run $run summary"
done

# WooCommerce keeps the placeholder attachment row even when the file is gone, so bootstrap restores it.
wpc eval 'unlink(get_attached_file(get_option("woocommerce_placeholder_image")));'
run_bootstrap >/dev/null || true
placeholder_url=$(wpc eval 'echo wp_get_attachment_url(get_option("woocommerce_placeholder_image"));')
[ "$(curl -s -o /dev/null -w '%{http_code}' "$placeholder_url")" = "200" ] || fail "placeholder image $placeholder_url"
pass "bootstrap restores a missing placeholder image"

# WordPress stores blogname HTML-escaped (&#039;), so compare the decoded value.
title=$(wpc eval 'echo html_entity_decode(get_option("blogname"), ENT_QUOTES);')
[ "$title" = "$TEST_TITLE" ] || fail "title: $title"
[ "$(wpc option get woocommerce_currency)" = "INR" ] || fail "currency"
[ "$(wpc option get woocommerce_ship_to_countries)" = "disabled" ] || fail "shipping disabled"
[ "$(wpc option get permalink_structure)" = "/%postname%/" ] || fail "permalinks"
[ "$(wpc post list --post_type=page --name=checkout --format=count)" = "1" ] || fail "one checkout page"
[ "$(wpc option get show_on_front)" = "page" ] || fail "static front page"
[ "$(wpc option get page_on_front)" = "$(wpc option get woocommerce_shop_page_id)" ] || fail "shop is the front page"
pass "options, permalinks and pages"

# The hash check needs the plain key inside the container, passed as CK.
match=$(docker exec -e CK="$TEST_CK" sit-wp wp --path=/var/www/html eval 'global $wpdb; echo $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_api_keys WHERE consumer_key = %s AND permissions = %s AND truncated_key = %s", wc_api_hash(getenv("CK")), "read_write", substr(getenv("CK"), -7)));')
[ "$match" = "1" ] || fail "stored key does not match WC_CONSUMER_KEY"
pass "stored key hash matches WC_CONSUMER_KEY"

keys=$(wpc eval 'global $wpdb; echo $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_api_keys WHERE description = \"mcp-gateway\"");')
[ "$keys" = "1" ] || fail "expected 1 mcp-gateway key, got $keys"
pass "exactly one mcp-gateway API key after two runs"

echo "OK"
