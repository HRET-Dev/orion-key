package com.orionkey.controller;

import com.orionkey.common.ApiResponse;
import com.orionkey.service.CouponService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/coupons")
@RequiredArgsConstructor
public class CouponController {

    private final CouponService couponService;

    @PostMapping("/preview")
    public ApiResponse<?> previewCoupon(@RequestBody Map<String, Object> request) {
        return ApiResponse.success(couponService.previewCoupon(request));
    }
}
