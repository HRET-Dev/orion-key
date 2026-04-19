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
import com.orionkey.service.BepusdtService;
import com.orionkey.service.CodepayWebhookService;
import com.orionkey.service.EpayWebhookService;
import com.orionkey.service.TxidVerifyService;
import com.orionkey.service.WebhookService;
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
public class WebhookServiceImpl implements WebhookService {

    private final WebhookEventRepository webhookEventRepository;
    private final OrderRepository orderRepository;
    private final PaymentChannelRepository paymentChannelRepository;
    private final BepusdtService bepusdtService;
    private final ObjectMapper objectMapper;
    private final TxidVerifyService txidVerifyService;
    private final EpayWebhookService epayWebhookService;
    private final CodepayWebhookService codepayWebhookService;

    @Override
    public String processEpayCallback(Map<String, String> params) {
        String outTradeNo = params.get("out_trade_no");
        if (isCodepayOrder(outTradeNo)) {
            log.info("Webhook dispatcher: /epay callback routed to codepay service, out_trade_no={}", outTradeNo);
            return codepayWebhookService.processCallback(params);
        }
        return epayWebhookService.processCallback(params);
    }

    @Override
    public String processCodepayCallback(Map<String, String> params) {
        return codepayWebhookService.processCallback(params);
    }

    @Override
    @Transactional
    public String processBepusdtCallback(Map<String, Object> params) {
        // BEpusdt 回调 JSON 含非 String 类型（amount: float64, status: int），
        // 转为 Map<String, String> 用于签名验证（Object.toString() 与 Go 的 fmt.Sprintf("%v", v) 输出一致）
        Map<String, String> signParams = new LinkedHashMap<>();
        for (var entry : params.entrySet()) {
            if (entry.getValue() != null) {
                signParams.put(entry.getKey(), entry.getValue().toString());
            }
        }

        String tradeId = signParams.get("trade_id");
        String orderId = signParams.get("order_id");
        String status = signParams.get("status");
        String blockTxId = signParams.get("block_transaction_id");
        String signature = signParams.get("signature");

        log.info("BEpusdt callback: trade_id={}, order_id={}, status={}, block_tx_id={}",
                tradeId, orderId, status, blockTxId);

        // 1. 幂等检查
        String eventId = "bepusdt_" + tradeId;
        if (webhookEventRepository.findByEventId(eventId).isPresent()) {
            log.info("BEpusdt callback already processed: {}", eventId);
            return "ok";
        }

        // 2. 解析订单
        UUID orderUuid;
        try {
            orderUuid = UUID.fromString(orderId);
        } catch (IllegalArgumentException e) {
            log.error("BEpusdt callback invalid order_id: {}", orderId);
            return "ok";
        }

        Order order = orderRepository.findById(orderUuid).orElse(null);
        if (order == null) {
            // F8: 订单未找到时不写入幂等表且返回 fail — 触发 BEpusdt 重试（可能是时序问题：回调先于订单落库）
            log.warn("BEpusdt callback order not found: {}, returning fail to trigger retry", orderId);
            return "fail";
        }

        // 3. 验签（apiToken 为空则拒绝，防止跳过签名验证）
        String apiToken = resolveBepusdtApiToken(order);
        if (apiToken == null) {
            log.error("BEpusdt callback rejected: api_token not configured for channel {}", order.getPaymentMethod());
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "NO_API_TOKEN");
            return "fail";
        }
        if (!bepusdtService.verifySign(apiToken, signParams, signature)) {
            log.error("BEpusdt callback signature verification failed: trade_id={}", tradeId);
            // F3: 签名失败不写入幂等表 — 否则攻击者可伪造回调占用 eventId，阻塞后续真实回调
            return "fail";
        }

        // 4. 状态检查（只处理 status=2 即支付成功）
        // 注意：非成功状态不写入幂等表，否则后续 status=2 回调会被误拦截
        if (!"2".equals(status)) {
            log.info("BEpusdt callback non-success status: {}, skipping (not saved to idempotency table)", status);
            return "ok";
        }

        // 5. 金额校验（actual_amount 和 usdtCryptoAmount 必须都存在且一致）
        String actualAmount = signParams.get("actual_amount");
        if (actualAmount == null || actualAmount.isBlank() || order.getUsdtCryptoAmount() == null) {
            log.error("BEpusdt callback missing amount data: actual_amount={}, orderCrypto={}, order={}",
                    actualAmount, order.getUsdtCryptoAmount(), orderId);
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "MISSING_AMOUNT");
            return "ok";
        }
        BigDecimal bepCallbackAmount;
        BigDecimal bepOrderAmount;
        try {
            bepCallbackAmount = new BigDecimal(actualAmount);
            bepOrderAmount = new BigDecimal(order.getUsdtCryptoAmount());
        } catch (NumberFormatException e) {
            log.error("BEpusdt callback invalid amount format: actual_amount={}, orderCrypto={}, order={}",
                    actualAmount, order.getUsdtCryptoAmount(), orderId);
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "INVALID_AMOUNT_FORMAT");
            return "ok";
        }
        if (bepCallbackAmount.compareTo(bepOrderAmount) != 0) {
            log.error("BEpusdt callback amount mismatch: expected={}, actual={}, order={}",
                    bepOrderAmount, bepCallbackAmount, orderId);
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "AMOUNT_MISMATCH");
            return "ok";
        }

        // 6. 链上验证 block_transaction_id（防止伪造回调 — 与 Epay 服务端查询网关等效）
        if (blockTxId == null || blockTxId.isBlank() || blockTxId.equals(tradeId)) {
            // status=2 但 block_transaction_id 不是真实链上哈希（等于 tradeId 或为空）
            // 不写入幂等表，返回 fail 触发 BEpusdt 重试（等待链上确认后重新回调）
            log.warn("BEpusdt callback status=2 but no real block_tx_id: trade_id={}, block_tx_id={}", tradeId, blockTxId);
            return "fail";
        }

        String chain = order.getUsdtChain() != null ? order.getUsdtChain() : order.getPaymentMethod();
        TxidVerifyService.ChainVerifyResult chainResult =
                txidVerifyService.verifyForWebhook(chain, blockTxId, order.getUsdtWalletAddress(), order.getUsdtCryptoAmount(), order.getCreatedAt());

        if (chainResult == null) {
            // 链上 API 查询失败（TronGrid/BscScan 不可用）— 不写入幂等表，返回 fail 触发重试
            log.warn("BEpusdt callback deferred: on-chain API unavailable, trade_id={}, txid={}", tradeId, blockTxId);
            return "fail";
        }
        if (!chainResult.verified()) {
            // 链上验证失败（交易不存在/未确认/地址不匹配/非USDT/金额不匹配）— 写入幂等表拒绝
            log.error("BEpusdt callback rejected by on-chain verification: {}, trade_id={}, txid={}",
                    chainResult.reason(), tradeId, blockTxId);
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(),
                    "ONCHAIN_VERIFY_FAILED: " + chainResult.reason());
            return "ok";
        }
        log.info("BEpusdt callback on-chain verification passed: trade_id={}, txid={}", tradeId, blockTxId);

        // 7. TXID 唯一性前置检查（防止同一链上交易被关联到多个订单）
        Optional<Order> txidExisting = orderRepository.findByUsdtTxId(blockTxId);
        if (txidExisting.isPresent() && !txidExisting.get().getId().equals(order.getId())) {
            log.error("BEpusdt callback TXID collision: txid={} already used by order {}, current order {}",
                    blockTxId, txidExisting.get().getId(), order.getId());
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "TXID_ALREADY_USED");
            return "ok";
        }

        // 8. 幂等更新订单状态（PENDING 和 EXPIRED 均可标记为 PAID，与 TXID 验证和管理员手动标记行为一致）
        if (order.getStatus() == OrderStatus.PENDING || order.getStatus() == OrderStatus.EXPIRED) {
            order.setStatus(OrderStatus.PAID);
            order.setPaidAt(LocalDateTime.now());
            order.setUsdtTxId(blockTxId);
            orderRepository.save(order);
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(), "SUCCESS");
            log.info("BEpusdt callback: order {} marked as PAID, txid={}", orderId, blockTxId);
        } else {
            saveWebhookEvent(eventId, "usdt", order.getId(), signParams.toString(),
                    "SKIPPED_" + order.getStatus().name());
            log.info("BEpusdt callback: order {} already {}", orderId, order.getStatus());
        }

        return "ok";
    }

    private boolean isCodepayOrder(String outTradeNo) {
        if (outTradeNo == null || outTradeNo.isBlank()) {
            return false;
        }
        UUID orderId;
        try {
            orderId = UUID.fromString(outTradeNo);
        } catch (Exception e) {
            return false;
        }
        Order order = orderRepository.findById(orderId).orElse(null);
        if (order == null || order.getPaymentMethod() == null || order.getPaymentMethod().isBlank()) {
            return false;
        }
        PaymentChannel channel = paymentChannelRepository
                .findByChannelCodeAndIsDeleted(order.getPaymentMethod(), 0)
                .orElse(null);
        if (channel == null) {
            return false;
        }
        if ("codepay".equalsIgnoreCase(channel.getProviderType())) {
            return true;
        }
        String channelCode = channel.getChannelCode();
        return channelCode != null && channelCode.toLowerCase(Locale.ROOT).startsWith("codepay");
    }

    private void saveWebhookEvent(String eventId, String channelCode, UUID orderId,
                                  String payload, String processResult) {
        WebhookEvent event = new WebhookEvent();
        event.setEventId(eventId);
        event.setChannelCode(channelCode);
        event.setOrderId(orderId != null ? orderId : UUID.fromString("00000000-0000-0000-0000-000000000000"));
        event.setPayload(payload);
        event.setProcessResult(processResult);
        webhookEventRepository.save(event);
    }

    /**
     * 从已有 Order 对象查找渠道 config_data 中的 BEpusdt API Token。
     */
    private String resolveBepusdtApiToken(Order order) {
        if (order.getPaymentMethod() != null) {
            PaymentChannel channel = paymentChannelRepository
                    .findByChannelCodeAndIsDeleted(order.getPaymentMethod(), 0)
                    .orElse(null);
            if (channel != null && channel.getConfigData() != null) {
                try {
                    Map<String, Object> cfg = objectMapper.readValue(
                            channel.getConfigData(), new TypeReference<>() {});
                    Object token = cfg.get("api_token");
                    if (token != null && !token.toString().isBlank()) {
                        return token.toString();
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse channel config for api_token: {}", e.getMessage());
                }
            }
        }
        log.warn("Cannot resolve BEpusdt API token for order {}", order.getId());
        return null;
    }
}
