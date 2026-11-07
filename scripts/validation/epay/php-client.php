<?php
// SPDX-License-Identifier: MIT
$input = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
require $argv[1];
$v2 = $input['protocol'] === 'epay_v2';
$client = new EpayCore($input['config']);
$request = $input['request'];
$url = $client->getPayLink($request);
parse_str(parse_url($url, PHP_URL_QUERY), $generated);
$created = $client->apiPay($request);
$queried = $client->queryOrder('202611070001');
$_GET = $input['notification'];
$notify = $v2 ? $client->verify($_GET) : $client->verifyNotify();
$_GET = $input['notification'];
$returned = $v2 ? $client->verify($_GET) : $client->verifyReturn();
$listed = $v2 ? $client->execute('api/merchant/orders', ['offset' => 0, 'limit' => 20]) : null;
echo json_encode(['request' => $generated, 'create' => $created, 'query' => $queried,
    'notify' => $notify, 'return' => $returned, 'list' => $listed], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
