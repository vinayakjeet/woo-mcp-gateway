FROM wordpress:7.1.3-php8.3-apache

ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832
ARG WOOCOMMERCE_VERSION=10.9.4
ARG WOOCOMMERCE_SHA256=6e58fc3ba9b18d1c9aee6b0227d3c3c09e4fe2c1332823bd2e0ac54ffcff64a9

# The official entrypoint copies /usr/src/wordpress into the empty volume on first boot,
# so WooCommerce placed here lands on the PVC without a download at runtime.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip; \
    curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    echo "${WP_CLI_SHA512}  /usr/local/bin/wp" | sha512sum -c -; \
    chmod 0755 /usr/local/bin/wp; \
    curl -fsSL -o /tmp/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    echo "${WOOCOMMERCE_SHA256}  /tmp/woocommerce.zip" | sha256sum -c -; \
    unzip -q /tmp/woocommerce.zip -d /usr/src/wordpress/wp-content/plugins; \
    chown -R www-data:www-data /usr/src/wordpress/wp-content/plugins/woocommerce; \
    rm /tmp/woocommerce.zip; \
    apt-get purge -y --auto-remove unzip; \
    rm -rf /var/lib/apt/lists/*

COPY healthz.php /usr/src/wordpress/healthz.php
COPY bootstrap.sh /opt/store/bootstrap.sh
COPY create-api-key.php /opt/store/create-api-key.php

# uid 33 cannot bind ports below 1024, so Apache listens on 8080. The Service maps 80 to it.
# chmod here instead of COPY --chmod, which needs BuildKit.
# Self-referential URLs (mod_dir's /wp-admin -> /wp-admin/) take the host from the Host header.
# The Ingress sends no port there, so Apache falls back to the vhost port. ServerName with :80
# makes that fallback 80, which URLs omit, instead of the internal 8080.
RUN set -eux; \
    chmod 0755 /opt/store/bootstrap.sh; \
    sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>\n\tServerName localhost:80\n\tUseCanonicalName Off/' /etc/apache2/sites-available/000-default.conf; \
    grep -qx 'Listen 8080' /etc/apache2/ports.conf; \
    grep -q '<VirtualHost \*:8080>' /etc/apache2/sites-available/000-default.conf; \
    grep -q 'ServerName localhost:80' /etc/apache2/sites-available/000-default.conf

EXPOSE 8080

# Numeric so Kubernetes can verify runAsNonRoot.
USER 33:33
