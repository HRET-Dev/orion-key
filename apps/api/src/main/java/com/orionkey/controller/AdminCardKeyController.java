package com.orionkey.controller;

import com.orionkey.annotation.LogOperation;
import com.orionkey.common.ApiResponse;
import com.orionkey.context.RequestContext;
import com.orionkey.service.AdminCardKeyService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/admin/card-keys")
@RequiredArgsConstructor
public class AdminCardKeyController {

    private final AdminCardKeyService adminCardKeyService;

    @GetMapping("/list")
    public ApiResponse<?> listCardKeys(
            @RequestParam("product_id") UUID productId,
            @RequestParam(value = "spec_id", required = false) UUID specId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(value = "page_size", defaultValue = "20") int pageSize) {
        return ApiResponse.success(adminCardKeyService.listCardKeys(productId, specId, page, pageSize));
    }

    @GetMapping("/stock")
    public ApiResponse<?> getStockSummary(
            @RequestParam(value = "product_id", required = false) UUID productId,
            @RequestParam(value = "spec_id", required = false) UUID specId) {
        return ApiResponse.success(adminCardKeyService.getStockSummary(productId, specId));
    }

    @LogOperation(action = "cardkey.import", targetType = "CARD_KEY", detail = "'导入卡密'")
    @PostMapping("/import")
    public ApiResponse<?> importCardKeys(@RequestBody Map<String, Object> request) {
        return ApiResponse.success(adminCardKeyService.importCardKeys(request, RequestContext.getUserId()));
    }

    @GetMapping("/import-batches")
    public ApiResponse<?> getImportBatches(
            @RequestParam(value = "product_id", required = false) UUID productId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(value = "page_size", defaultValue = "20") int pageSize) {
        return ApiResponse.success(adminCardKeyService.getImportBatches(productId, page, pageSize));
    }

    @LogOperation(action = "cardkey.update", targetType = "CARD_KEY", targetId = "#id", detail = "'修改卡密'")
    @PutMapping("/{id}")
    public ApiResponse<Void> updateCardKey(@PathVariable UUID id, @RequestBody Map<String, Object> request) {
        Object content = request.get("content");
        adminCardKeyService.updateCardKey(id, content instanceof String ? (String) content : null);
        return ApiResponse.success();
    }

    @LogOperation(action = "cardkey.delete", targetType = "CARD_KEY", targetId = "#id", detail = "'删除卡密'")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> deleteCardKey(@PathVariable UUID id) {
        adminCardKeyService.deleteCardKey(id);
        return ApiResponse.success();
    }

    @LogOperation(action = "cardkey.delete", targetType = "CARD_KEY", detail = "'批量删除卡密'")
    @PostMapping("/batch-delete")
    public ApiResponse<?> batchDeleteCardKeys(@RequestBody Map<String, Object> request) {
        @SuppressWarnings("unchecked")
        var rawIds = (java.util.List<String>) request.get("card_key_ids");
        if (rawIds == null || rawIds.isEmpty()) {
            throw new com.orionkey.exception.BusinessException(com.orionkey.constant.ErrorCode.BAD_REQUEST, "请选择要删除的卡密");
        }
        var cardKeyIds = rawIds.stream().map(UUID::fromString).toList();
        int count = adminCardKeyService.batchDeleteCardKeys(cardKeyIds);
        return ApiResponse.success(Map.of("deleted_count", count));
    }

    @LogOperation(action = "cardkey.invalidate", targetType = "CARD_KEY", targetId = "#id", detail = "'作废卡密'")
    @PostMapping("/{id}/invalidate")
    public ApiResponse<Void> invalidateCardKey(@PathVariable UUID id) {
        adminCardKeyService.invalidateCardKey(id);
        return ApiResponse.success();
    }

    @LogOperation(action = "cardkey.invalidate", targetType = "CARD_KEY", detail = "'批量作废'")
    @PostMapping("/batch-invalidate")
    public ApiResponse<?> batchInvalidateCardKeys(
            @RequestParam("product_id") UUID productId,
            @RequestParam(value = "spec_id", required = false) UUID specId) {
        int count = adminCardKeyService.batchInvalidateCardKeys(productId, specId);
        return ApiResponse.success(Map.of("invalidated_count", count));
    }

    @LogOperation(action = "cardkey.migrate", targetType = "CARD_KEY", detail = "'批量迁移'")
    @PostMapping("/batch-migrate")
    public ApiResponse<?> batchMigrateCardKeys(@RequestBody Map<String, Object> request) {
        @SuppressWarnings("unchecked")
        var rawIds = (java.util.List<String>) request.get("card_key_ids");
        if (rawIds == null || rawIds.isEmpty()) {
            throw new com.orionkey.exception.BusinessException(com.orionkey.constant.ErrorCode.BAD_REQUEST, "请选择要迁移的卡密");
        }
        var cardKeyIds = rawIds.stream().map(UUID::fromString).toList();
        UUID targetProductId = UUID.fromString((String) request.get("target_product_id"));
        UUID targetSpecId = request.get("target_spec_id") != null
                ? UUID.fromString((String) request.get("target_spec_id")) : null;
        int count = adminCardKeyService.batchMigrateCardKeys(cardKeyIds, targetProductId, targetSpecId);
        return ApiResponse.success(Map.of("migrated_count", count));
    }

    @GetMapping("/export")
    public ApiResponse<?> exportCardKeys(@RequestParam("product_id") UUID productId,
                                         @RequestParam(value = "spec_id", required = false) UUID specId) {
        return ApiResponse.success(adminCardKeyService.exportCardKeys(productId, specId));
    }

    @PostMapping("/export-selected")
    public ApiResponse<?> exportSelectedCardKeys(@RequestBody Map<String, Object> request) {
        @SuppressWarnings("unchecked")
        var rawIds = (java.util.List<String>) request.get("card_key_ids");
        if (rawIds == null || rawIds.isEmpty()) {
            throw new com.orionkey.exception.BusinessException(com.orionkey.constant.ErrorCode.BAD_REQUEST, "请选择要导出的卡密");
        }
        var cardKeyIds = rawIds.stream().map(UUID::fromString).toList();
        return ApiResponse.success(adminCardKeyService.exportCardKeysByIds(cardKeyIds));
    }

    @GetMapping("/by-order/{orderId}")
    public ApiResponse<?> getCardKeysByOrder(@PathVariable UUID orderId) {
        return ApiResponse.success(adminCardKeyService.getCardKeysByOrder(orderId));
    }
}
