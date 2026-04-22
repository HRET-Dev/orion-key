package com.orionkey.service;

import com.orionkey.common.PageResult;

import java.util.List;
import java.util.Map;
import java.util.UUID;

public interface AdminCardKeyService {

    List<?> getStockSummary(UUID productId, UUID specId);

    Map<String, Object> importCardKeys(Map<String, Object> request, UUID importedBy);

    PageResult<?> getImportBatches(UUID productId, int page, int pageSize);

    void updateCardKey(UUID id, String content);

    void deleteCardKey(UUID id);

    int batchDeleteCardKeys(List<UUID> cardKeyIds);

    void invalidateCardKey(UUID id);

    int batchInvalidateCardKeys(UUID productId, UUID specId);

    int batchMigrateCardKeys(List<UUID> cardKeyIds, UUID targetProductId, UUID targetSpecId);

    Map<String, Object> exportCardKeys(UUID productId, UUID specId);

    Map<String, Object> exportCardKeysByIds(List<UUID> cardKeyIds);

    List<?> getCardKeysByOrder(UUID orderId);

    PageResult<?> listCardKeys(UUID productId, UUID specId, int page, int pageSize);
}
