package com.orionkey.service;

import java.util.Map;

public interface CodepayWebhookService {

    /**
     * 处理码支付（provider_type=codepay）回调
     */
    String processCallback(Map<String, String> params);
}
