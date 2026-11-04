<?php
/* Originally from Icinga Web 2 icingadb Module | GPLv2+ */

namespace Icinga\Module\Clustergraph\Common;


use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use Icinga\Application\Config;
use Icinga\Exception\Http\HttpException;
use Icinga\Exception\Json\JsonDecodeException;
use Icinga\Util\Json;


class IcingaApi
{

    protected function getUriFor($endpoint,$transport)
    {
        return sprintf('https://%s:%u/v1/%s', $transport['host'], $transport['port'], $endpoint);
    }
    /**
     * Send the given command to the icinga2's REST API
     *
     * @param string     $method   HTTP method (sent as an override on a POST)
     * @param string     $endpoint Path below /v1/, with any query string
     * @param array|null $body     Optional JSON body, e.g. a filter with filter_vars
     *
     * @return mixed
     */
    public function sendCommand($method="GET", $endpoint='objects/zones', $body = null)
    {
        $transport =Config::module('clustergraph')->getSection("api")->toArray();

        $headers = ['Accept' => 'application/json'];
        if ($method !== 'POST') {
            $headers['X-HTTP-Method-Override'] = $method;
        }

        try {
            $options = [
                'auth'          => [$transport['username'], $transport['password']],
                'headers'       => $headers,
                'http_errors'   => false,
                'verify'        => false
            ];
            if ($body !== null) {
                $options['json'] = $body;
            }
            $response = (new Client())->post($this->getUriFor($endpoint,$transport), $options);
        } catch (GuzzleException $e) {

            throw new HttpException(
                'Can\'t connect to the Icinga 2 API: %u %s',
                $e->getCode(),
                $e->getMessage()
            );
        }

        try {
            $responseData = Json::decode((string) $response->getBody(), true);
        } catch (JsonDecodeException $e) {
            throw new HttpException(
                'Got invalid JSON response from the Icinga 2 API: %s',
                $e->getMessage()
            );
        }

        if (! isset($responseData['results']) || empty($responseData['results'])) {
            if (isset($responseData['error'])) {
                // 404 is "No objects found" for a filter that matches nothing
                if($responseData['error'] === 409 || $responseData['error'] === 404){
                    return [];
                }
                throw new HttpException(
                    'Can\'t send external Icinga command: %u %s',
                    $responseData['error'],
                    $responseData['status']
                );
            }

            return [];
        }

        $errorResult = $responseData['results'][0];
        if (isset($errorResult['code']) && ($errorResult['code'] < 200 || $errorResult['code'] >= 300)) {
            throw new HttpException(
                'Can\'t send external Icinga command: %u %s',
                $errorResult['code'],
                $errorResult['status']
            );
        }

        return $responseData['results'];
    }


}
