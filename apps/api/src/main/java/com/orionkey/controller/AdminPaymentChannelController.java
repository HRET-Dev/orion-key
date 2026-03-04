package com.orionkey.controller;

import com.orionkey.annotation.LogOperation;
import com.orionkey.common.ApiResponse;
import com.orionkey.service.AdminPaymentChannelService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/admin/payment-channels")
@RequiredArgsConstructor
public class AdminPaymentChannelController {

    private final AdminPaymentChannelService adminPaymentChannelService;

    @GetMapping
    public ApiResponse<?> listChannels() {
        return ApiResponse.success(adminPaymentChannelService.listChannels());
    }

    @LogOperation(action = "payment.create", targetType = "PAYMENT_CHANNEL")
    @PostMapping
    public ApiResponse<Void> createChannel(@RequestBody Map<String, Object> request) {
        adminPaymentChannelService.createChannel(request);
        return ApiResponse.success();
    }

    @LogOperation(action = "payment.update", targetType = "PAYMENT_CHANNEL", targetId = "#id")
    @PutMapping("/{id}")
    public ApiResponse<Void> updateChannel(@PathVariable UUID id, @RequestBody Map<String, Object> request) {
        adminPaymentChannelService.updateChannel(id, request);
        return ApiResponse.success();
    }

    @LogOperation(action = "payment.delete", targetType = "PAYMENT_CHANNEL", targetId = "#id")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> deleteChannel(@PathVariable UUID id) {
        adminPaymentChannelService.deleteChannel(id);
        return ApiResponse.success();
    }
}
