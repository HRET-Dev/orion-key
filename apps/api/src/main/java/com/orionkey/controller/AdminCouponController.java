package com.orionkey.controller;

import com.orionkey.annotation.LogOperation;
import com.orionkey.common.ApiResponse;
import com.orionkey.service.CouponService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/admin/coupons")
@RequiredArgsConstructor
public class AdminCouponController {

    private final CouponService couponService;

    @GetMapping
    public ApiResponse<?> listCoupons(@RequestParam(required = false) String keyword,
                                      @RequestParam(required = false) String status,
                                      @RequestParam(defaultValue = "1") int page,
                                      @RequestParam(value = "page_size", defaultValue = "20") int pageSize) {
        return ApiResponse.success(couponService.listAdminCoupons(keyword, status, page, pageSize));
    }

    @GetMapping("/{id}")
    public ApiResponse<?> getCoupon(@PathVariable UUID id) {
        return ApiResponse.success(couponService.getAdminCouponDetail(id));
    }

    @LogOperation(action = "coupon.create", targetType = "COUPON", detail = "'创建优惠券'")
    @PostMapping
    public ApiResponse<?> createCoupon(@RequestBody Map<String, Object> request) {
        return ApiResponse.success(couponService.createCoupon(request));
    }

    @LogOperation(action = "coupon.update", targetType = "COUPON", targetId = "#id", detail = "'修改优惠券'")
    @PutMapping("/{id}")
    public ApiResponse<Void> updateCoupon(@PathVariable UUID id, @RequestBody Map<String, Object> request) {
        couponService.updateCoupon(id, request);
        return ApiResponse.success();
    }

    @LogOperation(action = "coupon.delete", targetType = "COUPON", targetId = "#id", detail = "'删除优惠券'")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> deleteCoupon(@PathVariable UUID id) {
        couponService.deleteCoupon(id);
        return ApiResponse.success();
    }
}
