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
import com.orionkey.repository.PaymentChannelRepository;
import com.orionkey.service.BepusdtService;
import com.orionkey.service.BepusdtService.BepusdtConfig;
import com.orionkey.service.BepusdtService.BepusdtPaymentResult;
import com.orionkey.service.EpayService;
import com.orionkey.service.EpayService.ChannelConfig;
import com.orionkey.service.EpayService.EpayResult;
import com.orionkey.service.PaymentService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentServiceImpl implements PaymentService {

    /** channel_code → 易支付 type 映射（仅 provider_type=epay 时使用） */
    private static final Map<String, String> EPAY_TYPE_MAP = Map.of(
            "alipay", "alipay",
            "wechat", "wxpay"
    );

    private final PaymentChannelRepository paymentChannelRepository;
    private final OrderRepository orderRepository;
    private final OrderItemRepository orderItemRepository;
    private final EpayService epayService;
    private final BepusdtService bepusdtService;
    private final ObjectMapper objectMapper;

    @Override
    public Map<String, Object> createPayment(UUID orderId, String paymentMethod, BigDecimal amount) {
        // 1. 查找渠道并验证已启用
        PaymentChannel channel = paymentChannelRepository.findByChannelCodeAndIsDeleted(paymentMethod, 0)
                .filter(PaymentChannel::isEnabled)
                .orElseThrow(() -> new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "支付渠道不可用"));

        // 2. 查找订单
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new BusinessException(ErrorCode.ORDER_NOT_FOUND, "订单不存在"));

        // 3. 幂等：已有支付URL直接返回
        if (order.getPaymentUrl() != null && !order.getPaymentUrl().isEmpty()) {
            log.info("Returning cached payment URL for order: {}", orderId);
            return buildResult(order);
        }

        // 4. 按 providerType 路由到不同的支付实现
        String providerType = channel.getProviderType();
        switch (providerType) {
            case "epay" -> createEpayPayment(channel, order, paymentMethod, amount);
            case "native_alipay" -> throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "原生支付宝支付尚未实现，请使用易支付渠道");
            case "native_wxpay" -> throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "原生微信支付尚未实现，请使用易支付渠道");
            case "usdt" -> createBepusdtPayment(channel, order, amount);
            default -> throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "不支持的支付提供商类型: " + providerType);
        }

        return buildResult(order);
    }

    /**
     * BEpusdt USDT 下单流程
     */
    private void createBepusdtPayment(PaymentChannel channel, Order order, BigDecimal amount) {
        BepusdtConfig config = buildBepusdtConfig(channel);
        String productName = buildProductName(order.getId());

        BepusdtPaymentResult result = bepusdtService.createPayment(
                config, order.getId().toString(), amount, productName);

        order.setPaymentUrl(result.paymentUrl());
        order.setUsdtWalletAddress(result.walletAddress());
        order.setUsdtCryptoAmount(result.cryptoAmount());
        order.setUsdtTradeId(result.tradeId());
        order.setUsdtChain(channel.getChannelCode());
        orderRepository.save(order);
    }

    /**
     * 从渠道的 config_data JSON 构建 BepusdtConfig。
     */
    public BepusdtConfig buildBepusdtConfig(PaymentChannel channel) {
        Map<String, String> cfg = parseConfigData(channel.getConfigData());

        String apiUrl = requireConfig(cfg, "api_url", channel.getChannelCode());
        String apiToken = requireConfig(cfg, "api_token", channel.getChannelCode());
        String notifyUrl = requireConfig(cfg, "notify_url", channel.getChannelCode());
        String redirectUrl = cfg.getOrDefault("redirect_url", "");
        String tradeType = cfg.getOrDefault("trade_type", "usdt.trc20");
        String fiat = cfg.getOrDefault("fiat", "CNY");
        int timeout = Integer.parseInt(cfg.getOrDefault("timeout", "900"));
        BigDecimal tolerance = new BigDecimal(cfg.getOrDefault("auto_approve_tolerance", "1.5"));
        BigDecimal upper = new BigDecimal(cfg.getOrDefault("manual_review_upper", "5.0"));
        String fixedRate = cfg.getOrDefault("fixed_rate", "");

        return new BepusdtConfig(apiUrl, apiToken, notifyUrl, redirectUrl,
                tradeType, fiat, timeout, tolerance, upper, fixedRate);
    }

    /**
     * 易支付下单流程
     */
    private void createEpayPayment(PaymentChannel channel, Order order, String paymentMethod, BigDecimal amount) {
        String epayType = EPAY_TYPE_MAP.get(paymentMethod.toLowerCase());
        if (epayType == null) {
            throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE, "该渠道不支持易支付");
        }

        ChannelConfig config = buildChannelConfig(channel);
        String productName = buildProductName(order.getId());

        EpayResult epayResult = epayService.createPayment(
                config,
                order.getId().toString(),
                epayType,
                productName,
                amount,
                order.getClientIp()
        );

        String qrcodeUrl = epayResult.qrcodeUrl();
        String payUrl = epayResult.payUrl();
        order.setPaymentUrl(qrcodeUrl != null ? qrcodeUrl : payUrl);
        order.setEpayTradeNo(epayResult.tradeNo());
        orderRepository.save(order);
    }

    /**
     * 从渠道的 config_data JSON 构建 EpayService.ChannelConfig。
     * 所有必填字段均从数据库渠道配置读取，缺失则抛出异常。
     */
    public ChannelConfig buildChannelConfig(PaymentChannel channel) {
        Map<String, String> cfg = parseConfigData(channel.getConfigData());

        String pid = requireConfig(cfg, "pid", channel.getChannelCode());
        String key = requireConfig(cfg, "key", channel.getChannelCode());
        String apiUrl = requireConfig(cfg, "api_url", channel.getChannelCode());
        String notifyUrl = requireConfig(cfg, "notify_url", channel.getChannelCode());
        String returnUrl = requireConfig(cfg, "return_url", channel.getChannelCode());

        return new ChannelConfig(pid, key, apiUrl, notifyUrl, returnUrl);
    }

    private Map<String, Object> buildResult(Order order) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("order_id", order.getId());
        result.put("payment_url", order.getPaymentUrl());
        result.put("qrcode_url", order.getPaymentUrl());
        result.put("expires_at", order.getExpiresAt());

        // USDT 支付额外字段
        if (order.getUsdtWalletAddress() != null) {
            result.put("wallet_address", order.getUsdtWalletAddress());
            result.put("crypto_amount", order.getUsdtCryptoAmount());
            result.put("chain", order.getUsdtChain());
        }
        return result;
    }

    private String buildProductName(UUID orderId) {
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
            log.warn("Failed to parse channel config_data: {}", e.getMessage());
            return Map.of();
        }
    }

    private static String requireConfig(Map<String, String> cfg, String field, String channelCode) {
        String value = cfg.get(field);
        if (value == null || value.isBlank()) {
            throw new BusinessException(ErrorCode.CHANNEL_UNAVAILABLE,
                    "支付渠道 [" + channelCode + "] 缺少必填配置项: " + field + "，请在后台「支付渠道管理」中完善配置");
        }
        return value;
    }
}
