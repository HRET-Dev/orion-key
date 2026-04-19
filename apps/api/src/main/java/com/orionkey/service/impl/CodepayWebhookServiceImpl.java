package com.orionkey.service.impl;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orionkey.constant.OrderStatus;
import com.orionkey.entity.Order;
import com.orionkey.entity.PaymentChannel;
import com.orionkey.entity.WebhookEvent;
import com.orionkey.repository.OrderRepository;
import com.orionkey.repository.PaymentChannelRepository;
import com.orionkey.repository.WebhookEventRepository;
import com.orionkey.service.CodepayWebhookService;
import com.orionkey.service.EpayService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class CodepayWebhookServiceImpl implements CodepayWebhookService {

    private final WebhookEventRepository webhookEventRepository;
    private final OrderRepository orderRepository;
    private final PaymentChannelRepository paymentChannelRepository;
    private final EpayService epayService;
    private final ObjectMapper objectMapper;

    @Override
    @Transactional
    public String processCallback(Map<String, String> params) {
        String tradeNo = params.get("trade_no");
        String outTradeNo = params.get("out_trade_no");
        String tradeStatus = params.get("trade_status");
        String money = params.get("money");
        String sign = params.get("sign");

        log.info("Codepay callback: out_trade_no={}, trade_status={}, money={}", outTradeNo, tradeStatus, money);

        String eventId = "codepay_" + (tradeNo != null ? tradeNo : UUID.randomUUID());
        Optional<WebhookEvent> existingEvent = webhookEventRepository.findByEventId(eventId);
        if (existingEvent.isPresent()) {
            log.info("Codepay callback already processed: {}", eventId);
            return "SUCCESS";
        }

        UUID orderId;
        try {
            orderId = UUID.fromString(outTradeNo);
        } catch (Exception e) {
            log.error("Codepay callback invalid out_trade_no: {}", outTradeNo);
            return "FAIL";
        }

        Order order = orderRepository.findById(orderId).orElse(null);
        if (order == null) {
            log.warn("Codepay callback order not found: {}", orderId);
            return "FAIL";
        }

        PaymentChannel channel = resolveChannel(order);
        if (channel == null) {
            log.error("Codepay callback channel unavailable or provider mismatch: order={}, paymentMethod={}",
                    orderId, order.getPaymentMethod());
            return "FAIL";
        }

        String merchantKey = resolveMerchantKey(channel, orderId);
        if (merchantKey == null) {
            return "FAIL";
        }

        // 签名失败不写入幂等表，避免伪造回调占用 eventId
        if (!epayService.verifySign(merchantKey, params, sign)) {
            log.error("Codepay callback signature verification failed: out_trade_no={}, remote sign={}", outTradeNo, sign);
            return "FAIL";
        }

        if (!"TRADE_SUCCESS".equals(tradeStatus)) {
            log.info("Codepay callback non-success status: {}, skipping (not saved to idempotency table)", tradeStatus);
            return "SUCCESS";
        }

        WebhookEvent event = new WebhookEvent();
        event.setEventId(eventId);
        event.setChannelCode("codepay");
        event.setOrderId(orderId);
        event.setPayload(params.toString());

        if (money == null || money.isBlank()) {
            log.error("Codepay callback missing money parameter: out_trade_no={}", outTradeNo);
            event.setProcessResult("MISSING_AMOUNT");
            webhookEventRepository.save(event);
            return "FAIL";
        }

        BigDecimal callbackAmount;
        try {
            callbackAmount = new BigDecimal(money);
        } catch (NumberFormatException e) {
            log.error("Codepay callback invalid money format: {}, out_trade_no={}", money, outTradeNo);
            event.setProcessResult("INVALID_AMOUNT_FORMAT");
            webhookEventRepository.save(event);
            return "FAIL";
        }

        if (order.getActualAmount().compareTo(callbackAmount) != 0) {
            log.error("Codepay callback amount mismatch: order={}, callback={}", order.getActualAmount(), callbackAmount);
            event.setProcessResult("AMOUNT_MISMATCH");
            webhookEventRepository.save(event);
            return "FAIL";
        }

        EpayService.ChannelConfig channelConfig = resolveChannelConfig(channel, orderId);
        if (channelConfig != null) {
            EpayService.OrderQueryResult queryResult = epayService.queryOrder(channelConfig, outTradeNo);
            if (queryResult == null) {
                log.warn("Codepay callback deferred: server-side order query returned null, out_trade_no={}", outTradeNo);
                return "FAIL";
            }
            if (!isQueryStatusPaid(queryResult.tradeStatus())) {
                log.error("Codepay callback rejected: query status={}, expected TRADE_SUCCESS/1, out_trade_no={}",
                        queryResult.tradeStatus(), outTradeNo);
                event.setProcessResult("QUERY_STATUS_MISMATCH");
                webhookEventRepository.save(event);
                return "FAIL";
            }
            if (queryResult.money() != null) {
                try {
                    BigDecimal queryAmount = new BigDecimal(queryResult.money());
                    if (order.getActualAmount().compareTo(queryAmount) != 0) {
                        log.error("Codepay callback rejected: query amount={}, order amount={}, out_trade_no={}",
                                queryAmount, order.getActualAmount(), outTradeNo);
                        event.setProcessResult("QUERY_AMOUNT_MISMATCH");
                        webhookEventRepository.save(event);
                        return "FAIL";
                    }
                } catch (NumberFormatException e) {
                    log.warn("Codepay order query returned invalid money format: {}", queryResult.money());
                }
            }
            log.info("Codepay callback server-side verification passed: out_trade_no={}, queryStatus={}",
                    outTradeNo, queryResult.tradeStatus());
        } else {
            log.warn("Codepay callback: channel config incomplete, skipping server-side query verification for out_trade_no={}",
                    outTradeNo);
        }

        if (order.getStatus() == OrderStatus.PENDING) {
            order.setStatus(OrderStatus.PAID);
            order.setPaidAt(LocalDateTime.now());
            orderRepository.save(order);
            event.setProcessResult("SUCCESS");
            log.info("Codepay callback: order {} marked as PAID", orderId);
        } else {
            event.setProcessResult("SKIPPED_" + order.getStatus().name());
            log.info("Codepay callback: order {} already {}", orderId, order.getStatus());
        }

        webhookEventRepository.save(event);
        return "SUCCESS";
    }

    private PaymentChannel resolveChannel(Order order) {
        if (order.getPaymentMethod() == null || order.getPaymentMethod().isBlank()) {
            return null;
        }
        PaymentChannel channel = paymentChannelRepository
                .findByChannelCodeAndIsDeleted(order.getPaymentMethod(), 0)
                .orElse(null);
        if (channel == null) {
            return null;
        }
        String providerType = channel.getProviderType();
        if ("codepay".equalsIgnoreCase(providerType)) {
            return channel;
        }
        String channelCode = channel.getChannelCode();
        if (channelCode != null && channelCode.toLowerCase(Locale.ROOT).startsWith("codepay")) {
            return channel;
        }
        return null;
    }

    private String resolveMerchantKey(PaymentChannel channel, UUID orderId) {
        Map<String, String> cfg = parseConfigData(channel.getConfigData(), orderId);
        String key = cfg.get("key");
        if (key == null || key.isBlank()) {
            log.error("Cannot resolve merchant key for order {}: channel [{}] config missing key", orderId, channel.getChannelCode());
            return null;
        }
        return key;
    }

    private EpayService.ChannelConfig resolveChannelConfig(PaymentChannel channel, UUID orderId) {
        Map<String, String> cfg = parseConfigData(channel.getConfigData(), orderId);
        String pid = requireConfigValue(cfg, "pid");
        String key = requireConfigValue(cfg, "key");
        String apiUrl = requireConfigValue(cfg, "api_url");
        String notifyUrl = requireConfigValue(cfg, "notify_url");
        String returnUrl = requireConfigValue(cfg, "return_url");
        if (pid == null || key == null || apiUrl == null || notifyUrl == null || returnUrl == null) {
            return null;
        }
        return new EpayService.ChannelConfig(pid, key, apiUrl, notifyUrl, returnUrl);
    }

    private Map<String, String> parseConfigData(String configData, UUID orderId) {
        if (configData == null || configData.isBlank()) {
            return Map.of();
        }
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
            log.warn("Failed to parse codepay channel config for order {}: {}", orderId, e.getMessage());
            return Map.of();
        }
    }

    private String requireConfigValue(Map<String, String> cfg, String key) {
        String value = cfg.get(key);
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private boolean isQueryStatusPaid(String status) {
        return "TRADE_SUCCESS".equals(status) || "1".equals(status);
    }
}
