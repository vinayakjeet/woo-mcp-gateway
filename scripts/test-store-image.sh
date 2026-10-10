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

echo "OK"
