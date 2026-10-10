<?php
// Readiness for the WordPress pod. It must not load WordPress: the site is installed by a
// Helm post-install hook, and Helm runs that hook only after this probe passes.
mysqli_report(MYSQLI_REPORT_OFF);

$host = getenv('WORDPRESS_DB_HOST') ?: 'mysql';
$port = 3306;
if (str_contains($host, ':')) {
    [$host, $portText] = explode(':', $host, 2);
    $port = (int) $portText;
}

$db = mysqli_init();
$db->options(MYSQLI_OPT_CONNECT_TIMEOUT, 2);
$ok = @$db->real_connect(
    $host,
    getenv('WORDPRESS_DB_USER') ?: '',
    getenv('WORDPRESS_DB_PASSWORD') ?: '',
    getenv('WORDPRESS_DB_NAME') ?: '',
    $port
);
if ($ok) {
    $db->close();
}

if (PHP_SAPI === 'cli') {
    echo $ok ? "ok\n" : "db unavailable\n";
    exit($ok ? 0 : 1);
}

header('Content-Type: text/plain');
header('Cache-Control: no-store');
http_response_code($ok ? 200 : 503);
echo $ok ? "ok\n" : "db unavailable\n";
