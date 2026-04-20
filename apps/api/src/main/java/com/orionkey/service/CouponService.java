package com.orionkey.service;

import com.orionkey.entity.Coupon;
import com.orionkey.entity.Order;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public interface CouponService {

    record CouponLineItem(UUID productId, BigDecimal subtotal) {}

    record AppliedCoupon(Coupon coupon, BigDecimal discountAmount) {}

    record PreviewItem(UUID productId, UUID specId, int quantity) {}

    Object listAdminCoupons(String keyword, String status, int page, int pageSize);

    Object getAdminCouponDetail(UUID id);

    Object createCoupon(Map<String, Object> request);

    void updateCoupon(UUID id, Map<String, Object> request);

    void deleteCoupon(UUID id);

    Object previewCoupon(Map<String, Object> request);

    AppliedCoupon prepareCoupon(String couponCode, List<CouponLineItem> items);

    void occupyCoupon(Coupon coupon, Order order);

    void releaseCouponForOrder(Order order);

    void releaseCouponsForOrders(List<Order> orders);
}
