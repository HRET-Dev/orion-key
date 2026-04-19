package com.orionkey.service;

import com.orionkey.entity.Order;
import com.orionkey.entity.PaymentChannel;

import java.math.BigDecimal;
import java.util.Map;

public interface CodepayService {
    Map<String, Object> createPayment(PaymentChannel channel, Order order, String paymentMethod, BigDecimal amount, String device);
}
