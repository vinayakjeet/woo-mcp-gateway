<?php
// Runs through `wp eval-file`, so WordPress, WooCommerce and WP_CLI are loaded.
// The key is replaced on every run so the stored hash always matches Secret store-wc-api.
global $wpdb;

$ck = getenv('WC_CONSUMER_KEY');
$cs = getenv('WC_CONSUMER_SECRET');
if (!is_string($ck) || !preg_match('/^ck_[0-9a-f]{40}$/', $ck)
    || !is_string($cs) || !preg_match('/^cs_[0-9a-f]{40}$/', $cs)) {
    WP_CLI::error('WC_CONSUMER_KEY or WC_CONSUMER_SECRET is missing or malformed.');
}

$table = $wpdb->prefix . 'woocommerce_api_keys';
if ($wpdb->delete($table, ['description' => 'mcp-gateway'], ['%s']) === false) {
    WP_CLI::error('Could not delete the old mcp-gateway API key.');
}

$inserted = $wpdb->insert(
    $table,
    [
        'user_id' => 1,
        'description' => 'mcp-gateway',
        'permissions' => 'read_write',
        // WooCommerce stores the key hashed and looks it up with wc_api_hash().
        'consumer_key' => wc_api_hash($ck),
        'consumer_secret' => $cs,
        'truncated_key' => substr($ck, -7),
    ],
    ['%d', '%s', '%s', '%s', '%s', '%s']
);
if ($inserted !== 1) {
    WP_CLI::error('Could not insert the mcp-gateway API key.');
}
