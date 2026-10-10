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

start_db
wait_code 200
pass "healthz.php 200 on an empty, uninstalled database"

docker stop sit-db >/dev/null
wait_code 503
pass "healthz.php 503 after the database stops"
docker start sit-db >/dev/null
wait_code 200

echo "OK"
