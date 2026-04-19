package com.orionkey.service;

import java.util.Map;

public interface EpayWebhookService {

    /**
     * 处理易支付（provider_type=epay）回调
     */
    String processCallback(Map<String, String> params);
}
