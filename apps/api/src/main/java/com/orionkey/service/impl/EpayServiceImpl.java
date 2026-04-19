package com.orionkey.service.impl;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orionkey.constant.ErrorCode;
import com.orionkey.exception.BusinessException;
import com.orionkey.service.EpayService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

@Slf4j
@Service
@RequiredArgsConstructor
public class EpayServiceImpl implements EpayService {

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Override
    public EpayResult createPayment(ChannelConfig config, String outTradeNo, String type, String name,
                                    BigDecimal money, String clientIp, String device) {
        String dynamicReturnUrl = appendOrderId(config.returnUrl(), outTradeNo);

        Map<String, String> params = new LinkedHashMap<>();
        params.put("pid", config.pid());
        params.put("type", type);
        params.put("out_trade_no", outTradeNo);
        params.put("notify_url", config.notifyUrl());
        params.put("return_url", dynamicReturnUrl);
        params.put("name", name);
        params.put("money", money.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        params.put("clientip", clientIp != null ? clientIp : "127.0.0.1");
        params.put("device", device != null && !device.isBlank() ? device : "pc");

        log.info("Epay createPayment: outTradeNo={}, type={}, money={}, apiUrl={}", outTradeNo, type, money, config.apiUrl());

        MultiValueMap<String, String> formData = new LinkedMultiValueMap<>();
        params.forEach(formData::add);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        HttpEntity<MultiValueMap<String, String>> request = new HttpEntity<>(formData, headers);

        String url = config.apiUrl() + (config.apiUrl().endsWith("/") ? "" : "/") + "mapi.php";

        int maxRetries = 2;
        Exception lastException = null;
        List<String> signCandidates = buildSignCandidates(config.key(), params);

        for (int signIndex = 0; signIndex < signCandidates.size(); signIndex++) {
            String currentSign = signCandidates.get(signIndex);
            formData.set("sign", currentSign);
            formData.set("sign_type", "MD5");
            log.debug("Epay request sign strategy index={}, sign={}", signIndex, currentSign);

            for (int attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    sleepBeforeRetry(attempt, maxRetries, signIndex);
                }

                try {
                    GatewayResponse resp = sendGatewayRequest(url, request);
                    if (resp.code == 1) {
                        return buildResult(resp, device);
                    }

                    if (isInvalidSignature(resp.msg)) {
                        if (signIndex < signCandidates.size() - 1) {
                            log.warn("Epay signature rejected by gateway, switching sign strategy to index={} and retrying", signIndex + 1);
                            break;
                        }
                        throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL,
                                "支付创建失败：网关验签失败，请检查 PID/KEY 与签名规则");
                    }

                    log.error("Epay API error: code={}, msg={}", resp.code, resp.msg);
                    throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL, "支付创建失败：" + resp.msg);
                } catch (BusinessException e) {
                    throw e;
                } catch (Exception e) {
                    lastException = e;
                    log.warn("Epay API attempt {} failed (sign strategy index={}): {}", attempt + 1, signIndex, e.getMessage());
                }
            }
        }

        log.error("Epay API call failed after {} retries", maxRetries + 1, lastException);
        throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL, "支付创建失败：网络超时，请重试");
    }

    private static String appendOrderId(String baseReturnUrl, String outTradeNo) {
        return baseReturnUrl + (baseReturnUrl.contains("?") ? "&" : "?") + "orderId=" + outTradeNo;
    }

    private void sleepBeforeRetry(int attempt, int maxRetries, int signIndex) {
        try {
            log.info("Epay API retry attempt {}/{} (sign strategy index={})", attempt, maxRetries, signIndex);
            Thread.sleep(1000);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL, "支付创建失败：请求被中断");
        }
    }

    private GatewayResponse sendGatewayRequest(String url, HttpEntity<MultiValueMap<String, String>> request) {
        ResponseEntity<String> response = restTemplate.postForEntity(url, request, String.class);
        String responseBody = response.getBody();

        if (responseBody == null || responseBody.isBlank()) {
            log.error("Epay API returned null/empty body");
            throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL, "支付创建失败：响应为空");
        }

        log.debug("Epay API raw response: {}", responseBody);

        Map<String, Object> body;
        try {
            body = objectMapper.readValue(responseBody, new TypeReference<>() {});
        } catch (Exception parseEx) {
            log.error("Epay API response is not valid JSON: {}", responseBody);
            throw new BusinessException(ErrorCode.WEBHOOK_VERIFY_FAIL, "支付创建失败：响应格式异常");
        }

        Object codeObj = body.get("code");
        int code = codeObj instanceof Number ? ((Number) codeObj).intValue() : -1;
        String msg = body.get("msg") != null ? body.get("msg").toString() : "";
        String tradeNo = body.get("trade_no") != null ? body.get("trade_no").toString() : "";
        String payUrl = body.get("payurl") != null ? body.get("payurl").toString() : null;
        String qrcode = body.get("qrcode") != null ? body.get("qrcode").toString() : null;
        String urlscheme = body.get("urlscheme") != null ? body.get("urlscheme").toString() : null;

        log.info("Epay API response: code={}, msg={}, tradeNo={}, payUrl={}, qrcode={}", code, msg, tradeNo, payUrl, qrcode);
        return new GatewayResponse(code, msg, tradeNo, payUrl, qrcode, urlscheme);
    }

    private EpayResult buildResult(GatewayResponse resp, String device) {
        String resultQrcode = resp.qrcode != null ? resp.qrcode : resp.urlscheme;
        String effectivePayUrl = resp.payUrl;

        if (effectivePayUrl == null && device != null && !"pc".equals(device) && resultQrcode != null) {
            effectivePayUrl = resultQrcode;
            log.info("Epay: gateway returned no payUrl, using qrcode URL as mobile redirect: {}", effectivePayUrl);
        }

        return new EpayResult(resp.code, resp.msg, resp.tradeNo, effectivePayUrl, resultQrcode);
    }

    private boolean isInvalidSignature(String msg) {
        return msg != null && msg.toLowerCase(Locale.ROOT).contains("invalid signature");
    }

    @Override
    public String buildSign(String merchantKey, Map<String, String> params) {
        return signWithKeyMode(merchantKey, params, false, false);
    }

    private String buildSignKeyParam(String merchantKey, Map<String, String> params) {
        return signWithKeyMode(merchantKey, params, true, false);
    }

    private String buildSignUpper(String merchantKey, Map<String, String> params, boolean keyAsParam) {
        return signWithKeyMode(merchantKey, params, keyAsParam, true);
    }

    private String signWithKeyMode(String merchantKey, Map<String, String> params, boolean keyAsParam, boolean upperCase) {
        TreeMap<String, String> sorted = new TreeMap<>();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();
            if ("sign".equals(key) || "sign_type".equals(key)) continue;
            if (value == null || value.isEmpty()) continue;
            sorted.put(key, value);
        }

        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : sorted.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(entry.getKey()).append('=').append(entry.getValue());
        }

        if (keyAsParam) {
            if (sb.length() > 0) sb.append('&');
            sb.append("key=").append(merchantKey);
        } else {
            sb.append(merchantKey);
        }

        String sign = md5(sb.toString());
        return upperCase ? sign.toUpperCase(Locale.ROOT) : sign;
    }

    private List<String> buildSignCandidates(String merchantKey, Map<String, String> params) {
        LinkedHashSet<String> set = new LinkedHashSet<>();
        set.add(buildSign(merchantKey, params));
        set.add(buildSignKeyParam(merchantKey, params));
        set.add(buildSignUpper(merchantKey, params, false));
        set.add(buildSignUpper(merchantKey, params, true));
        return new ArrayList<>(set);
    }

    @Override
    public OrderQueryResult queryOrder(ChannelConfig config, String outTradeNo) {
        String url = config.apiUrl() + (config.apiUrl().endsWith("/") ? "" : "/")
                + "api.php?act=order&pid=" + config.pid() + "&key=" + config.key()
                + "&out_trade_no=" + outTradeNo;

        try {
            ResponseEntity<String> response = restTemplate.getForEntity(url, String.class);
            String body = response.getBody();
            if (body == null || body.isBlank()) {
                log.warn("Epay order query returned empty body: outTradeNo={}", outTradeNo);
                return null;
            }
            log.debug("Epay order query response: {}", body);

            Map<String, Object> result = objectMapper.readValue(body, new TypeReference<>() {});
            if (result.containsKey("code") && !Integer.valueOf(1).equals(result.get("code"))) {
                log.warn("Epay order query error: {}", body);
                return null;
            }

            String tradeStatus = result.get("status") != null ? result.get("status").toString() : null;
            String respMoney = result.get("money") != null ? result.get("money").toString() : null;
            String tradeNo = result.get("trade_no") != null ? result.get("trade_no").toString() : null;
            return new OrderQueryResult(tradeStatus, respMoney, tradeNo);
        } catch (Exception e) {
            log.warn("Epay order query failed: outTradeNo={}, error={}", outTradeNo, e.getMessage());
            return null;
        }
    }

    @Override
    public boolean verifySign(String merchantKey, Map<String, String> params, String sign) {
        if (sign == null || sign.isEmpty()) return false;
        for (String expected : buildSignCandidates(merchantKey, params)) {
            if (expected.equalsIgnoreCase(sign)) {
                return true;
            }
        }
        return false;
    }

    private String md5(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("MD5 algorithm not available", e);
        }
    }

    private record GatewayResponse(int code, String msg, String tradeNo, String payUrl, String qrcode, String urlscheme) {}
}
