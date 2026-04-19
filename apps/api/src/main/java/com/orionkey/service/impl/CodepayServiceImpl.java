package com.orionkey.service.impl;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orionkey.constant.ErrorCode;
import com.orionkey.entity.Order;
import com.orionkey.entity.OrderItem;
import com.orionkey.entity.PaymentChannel;
import com.orionkey.exception.BusinessException;
import com.orionkey.repository.OrderItemRepository;
import com.orionkey.repository.OrderRepository;
import com.orionkey.service.CodepayService;
import com.orionkey.service.EpayService;
import com.orionkey.service.EpayService.ChannelConfig;
import com.orionkey.service.EpayService.EpayResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class CodepayServiceImpl implements CodepayService {

    private static final Map<String, String> CODEPAY_TYPE_MAP = Map.of(
            "codepay_alipay", "alipay",
            "codepay_wechat", "wxpay"
    );

    private final EpayService epayService;
    private final OrderRepository orderRepository;
    private final OrderItemRepository orderItemRepository;
    private final ObjectMapper objectMapper;

    @Override
    public Map<String, Object> createPayment(PaymentChannel channel, Order order, String paymentMethod, BigDecimal amount, String device) {
        Map<String, String> cfg = parseConfigData(channel.getConfigData());
        String epayType = cfg.get("epay_type");
        if (epayType == null || epayType.isBlank()) epayType = cfg.get("type");
        if (epayType == null || epayType.isBlank()) epayType = cfg.get("pay_type");
        if (epayType == null || epayType.isBlank()) epayType = CODEPAY_TYPE_MAP.get(paymentMethod.toLowerCase());
        if (epayType == null) {
            throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "该码支付渠道缺少 epay_type 配置（如 alipay/wxpay）");
        }

        ChannelConfig config = buildChannelConfig(channel, cfg);
        String productName = buildProductName(order.getId());
        boolean mapiEnabled = parseBooleanConfig(cfg.get("mapi_enabled"), true);

        if (!mapiEnabled) {
            return buildHostedCheckoutResult(config, order, epayType, productName, amount);
        }

        EpayResult epayResult = epayService.createPayment(
                config,
                order.getId().toString(),
                epayType,
                productName,
                amount,
                order.getClientIp(),
                device
        );

        if ((epayResult.payUrl() == null || epayResult.payUrl().isBlank())
                && (epayResult.qrcodeUrl() == null || epayResult.qrcodeUrl().isBlank())) {
            throw new BusinessException(
                    ErrorCode.WEBHOOK_VERIFY_FAIL,
                    "码支付创建失败：网关未返回可用支付链接或二维码，请检查渠道配置"
            );
        }

        order.setPaymentUrl(epayResult.payUrl());
        order.setQrcodeUrl(epayResult.qrcodeUrl());
        order.setEpayTradeNo(epayResult.tradeNo());
        orderRepository.save(order);

        return buildResult(order);
    }

    private Map<String, Object> buildHostedCheckoutResult(ChannelConfig config,
                                                          Order order,
                                                          String epayType,
                                                          String productName,
                                                          BigDecimal amount) {
        String dynamicReturnUrl = appendOrderId(config.returnUrl(), order.getId().toString());

        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("pid", config.pid());
        fields.put("type", epayType);
        fields.put("out_trade_no", order.getId().toString());
        fields.put("notify_url", config.notifyUrl());
        fields.put("return_url", dynamicReturnUrl);
        fields.put("name", productName);
        fields.put("money", amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        fields.put("sign", epayService.buildSign(config.key(), fields));
        fields.put("sign_type", "MD5");

        Map<String, Object> result = buildResult(order);
        result.put("hosted_page_action", buildHostedCheckoutAction(config.apiUrl()));
        result.put("hosted_page_fields", fields);
        return result;
    }

    private String buildHostedCheckoutAction(String apiUrl) {
        String normalized = apiUrl + (apiUrl.endsWith("/") ? "" : "/");
        return normalized + "submit.php";
    }

    private Map<String, Object> buildResult(Order order) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("order_id", order.getId());
        String effectiveUrl = order.getQrcodeUrl() != null ? order.getQrcodeUrl() : order.getPaymentUrl();
        result.put("payment_url", effectiveUrl);
        result.put("qrcode_url", order.getQrcodeUrl());
        result.put("pay_url", order.getPaymentUrl());
        result.put("expires_at", order.getExpiresAt());
        return result;
    }

    private ChannelConfig buildChannelConfig(PaymentChannel channel, Map<String, String> cfg) {
        String pid = requireConfig(cfg, "pid", channel.getChannelCode());
        String key = requireConfig(cfg, "key", channel.getChannelCode());
        String apiUrl = requireConfig(cfg, "api_url", channel.getChannelCode());
        String notifyUrl = requireConfig(cfg, "notify_url", channel.getChannelCode());
        String returnUrl = requireConfig(cfg, "return_url", channel.getChannelCode());
        return new ChannelConfig(pid, key, apiUrl, notifyUrl, returnUrl);
    }

    private String buildProductName(java.util.UUID orderId) {
        List<OrderItem> items = orderItemRepository.findByOrderId(orderId);
        if (items.isEmpty()) return "Orion Key 订单";
        String firstName = items.getFirst().getProductTitle();
        if (items.size() == 1) return firstName;
        return firstName + " 等" + items.size() + "件商品";
    }

    private Map<String, String> parseConfigData(String configData) {
        if (configData == null || configData.isBlank()) return Map.of();
        try {
            Map<String, Object> raw = objectMapper.readValue(configData, new TypeReference<>() {});
            Map<String, String> result = new LinkedHashMap<>();
            for (var entry : raw.entrySet()) {
                if (entry.getValue() != null) {
                    result.put(entry.getKey(), entry.getValue().toString());
                }
            }
            return result;
        } catch (Exception e) {
            log.warn("Failed to parse codepay config_data: {}", e.getMessage());
            return Map.of();
        }
    }

    private boolean parseBooleanConfig(String value, boolean defaultValue) {
        if (value == null || value.isBlank()) {
            return defaultValue;
        }
        return switch (value.trim().toLowerCase()) {
            case "1", "true", "yes", "on" -> true;
            case "0", "false", "no", "off" -> false;
            default -> defaultValue;
        };
    }

    private String appendOrderId(String returnUrl, String orderId) {
        if (returnUrl == null || returnUrl.isBlank() || orderId == null || orderId.isBlank()) {
            return returnUrl;
        }
        String separator = returnUrl.contains("?") ? "&" : "?";
        return returnUrl + separator + "orderId=" + orderId;
    }

    private static String requireConfig(Map<String, String> cfg, String field, String channelCode) {
        String value = cfg.get(field);
        if (value != null) value = value.trim();
        if (value == null || value.isBlank()) {
            throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE,
                    "支付渠道 [" + channelCode + "] 缺少必填配置项: " + field + "，请在后台「支付渠道管理」中完善配置");
        }
        return value;
    }
}
