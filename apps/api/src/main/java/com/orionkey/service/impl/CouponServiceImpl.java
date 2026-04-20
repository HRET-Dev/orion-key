package com.orionkey.service.impl;

import com.orionkey.common.PageResult;
import com.orionkey.constant.CouponStatus;
import com.orionkey.constant.CouponType;
import com.orionkey.constant.ErrorCode;
import com.orionkey.entity.*;
import com.orionkey.exception.BusinessException;
import com.orionkey.repository.*;
import com.orionkey.service.CouponService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class CouponServiceImpl implements CouponService {

    private final CouponRepository couponRepository;
    private final CouponProductRepository couponProductRepository;
    private final ProductRepository productRepository;
    private final ProductSpecRepository productSpecRepository;
    private final WholesaleRuleRepository wholesaleRuleRepository;
    private final OrderRepository orderRepository;

    @Override
    public Object listAdminCoupons(String keyword, String status, int page, int pageSize) {
        CouponStatus couponStatus = parseStatus(status);
        String keywordPattern = normalizeKeyword(keyword);
        Page<Coupon> couponPage = couponRepository.searchAdminCoupons(couponStatus, keywordPattern, PageRequest.of(page - 1, pageSize));
        List<Coupon> coupons = couponPage.getContent();
        Map<UUID, List<CouponProduct>> relations = loadCouponProducts(coupons.stream().map(Coupon::getId).toList());
        Map<UUID, Product> productMap = loadProducts(relations.values().stream()
                .flatMap(List::stream)
                .map(CouponProduct::getProductId)
                .collect(Collectors.toSet()));
        List<Map<String, Object>> list = coupons.stream()
                .map(coupon -> toCouponMap(coupon, relations.getOrDefault(coupon.getId(), List.of()), productMap))
                .toList();
        return PageResult.of(couponPage, list);
    }

    @Override
    public Object getAdminCouponDetail(UUID id) {
        Coupon coupon = couponRepository.findActiveById(id)
                .orElseThrow(() -> new BusinessException(ErrorCode.COUPON_NOT_FOUND, "优惠券不存在"));
        List<CouponProduct> relations = couponProductRepository.findByCouponId(id);
        Map<UUID, Product> productMap = loadProducts(relations.stream().map(CouponProduct::getProductId).collect(Collectors.toSet()));
        return toCouponMap(coupon, relations, productMap);
    }

    @Override
    @Transactional
    public Object createCoupon(Map<String, Object> request) {
        CouponPayload payload = parsePayload(request, null);
        if (couponRepository.existsActiveCode(payload.code(), null)) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠券编码已存在");
        }

        Coupon coupon = new Coupon();
        applyPayload(coupon, payload);
        coupon.setStatus(CouponStatus.UNUSED);
        coupon.setUsedOrderId(null);
        coupon.setUsedAt(null);
        couponRepository.save(coupon);
        replaceCouponProducts(coupon, payload.productIds());
        return getAdminCouponDetail(coupon.getId());
    }

    @Override
    @Transactional
    public void updateCoupon(UUID id, Map<String, Object> request) {
        Coupon coupon = couponRepository.findActiveById(id)
                .orElseThrow(() -> new BusinessException(ErrorCode.COUPON_NOT_FOUND, "优惠券不存在"));
        if (coupon.getStatus() == CouponStatus.USED) {
            throw new BusinessException(ErrorCode.COUPON_ALREADY_USED, "已使用的优惠券不允许修改");
        }
        CouponPayload payload = parsePayload(request, id);
        if (couponRepository.existsActiveCode(payload.code(), id)) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠券编码已存在");
        }
        applyPayload(coupon, payload);
        couponRepository.save(coupon);
        replaceCouponProducts(coupon, payload.productIds());
    }

    @Override
    @Transactional
    public void deleteCoupon(UUID id) {
        Coupon coupon = couponRepository.findActiveById(id)
                .orElseThrow(() -> new BusinessException(ErrorCode.COUPON_NOT_FOUND, "优惠券不存在"));
        if (coupon.getStatus() == CouponStatus.USED) {
            throw new BusinessException(ErrorCode.COUPON_ALREADY_USED, "已使用的优惠券不允许删除");
        }
        coupon.setIsDeleted(1);
        couponRepository.save(coupon);
        couponProductRepository.deleteByCouponId(id);
    }

    @Override
    public Object previewCoupon(Map<String, Object> request) {
        String code = normalizeCode((String) request.get("code"));
        if (code == null || code.isBlank()) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "请输入优惠券码");
        }
        List<PreviewItem> items = parsePreviewItems(request.get("items"));
        if (items.isEmpty()) {
            throw new BusinessException(ErrorCode.BAD_REQUEST, "缺少预览商品信息");
        }
        List<CouponLineItem> lineItems = buildLineItems(items);
        Coupon coupon = couponRepository.findActiveByCode(code)
                .orElseThrow(() -> new BusinessException(ErrorCode.COUPON_NOT_FOUND, "优惠券不存在"));
        AppliedCoupon appliedCoupon = calculateAppliedCoupon(coupon, lineItems);

        BigDecimal totalAmount = lineItems.stream()
                .map(CouponLineItem::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        Set<UUID> eligibleProductIds = resolveEligibleProductIds(coupon,
                lineItems.stream().map(CouponLineItem::productId).collect(Collectors.toSet()));

        Map<String, Object> map = new LinkedHashMap<>();
        map.put("coupon_id", coupon.getId());
        map.put("code", coupon.getCode());
        map.put("name", coupon.getName());
        map.put("type", coupon.getType().name());
        map.put("discount_value", coupon.getDiscountValue());
        map.put("min_order_amount", coupon.getMinOrderAmount());
        map.put("discount_amount", appliedCoupon.discountAmount());
        map.put("eligible_amount", eligibleSubtotal(coupon, lineItems));
        map.put("total_amount", totalAmount);
        map.put("actual_amount", totalAmount.subtract(appliedCoupon.discountAmount()).max(BigDecimal.ZERO));
        map.put("applies_to_all_products", coupon.isAppliesToAllProducts());
        map.put("eligible_product_ids", eligibleProductIds);
        return map;
    }

    @Override
    @Transactional
    public AppliedCoupon prepareCoupon(String couponCode, List<CouponLineItem> items) {
        if (couponCode == null || couponCode.isBlank()) {
            return null;
        }
        Coupon coupon = couponRepository.findActiveByCodeForUpdate(normalizeCode(couponCode))
                .orElseThrow(() -> new BusinessException(ErrorCode.COUPON_NOT_FOUND, "优惠券不存在"));
        return calculateAppliedCoupon(coupon, items);
    }

    @Override
    @Transactional
    public void occupyCoupon(Coupon coupon, Order order) {
        if (coupon == null || order == null) {
            return;
        }
        if (coupon.getStatus() == CouponStatus.USED && !order.getId().equals(coupon.getUsedOrderId())) {
            throw new BusinessException(ErrorCode.COUPON_ALREADY_USED, "优惠券已被使用");
        }
        coupon.setStatus(CouponStatus.USED);
        coupon.setUsedOrderId(order.getId());
        coupon.setUsedAt(LocalDateTime.now());
        couponRepository.save(coupon);
    }

    @Override
    @Transactional
    public void releaseCouponForOrder(Order order) {
        if (order == null || order.getCouponId() == null) {
            return;
        }
        couponRepository.findActiveById(order.getCouponId()).ifPresent(coupon -> {
            if (order.getId().equals(coupon.getUsedOrderId())) {
                coupon.setStatus(CouponStatus.UNUSED);
                coupon.setUsedOrderId(null);
                coupon.setUsedAt(null);
                couponRepository.save(coupon);
            }
        });
        order.setCouponId(null);
        order.setCouponCode(null);
        order.setCouponDiscount(BigDecimal.ZERO);
        order.setActualAmount(calculateActualAmount(order.getTotalAmount(), order.getPointsDiscount()));
        orderRepository.save(order);
    }

    @Override
    @Transactional
    public void releaseCouponsForOrders(List<Order> orders) {
        if (orders == null || orders.isEmpty()) {
            return;
        }
        orders.forEach(this::releaseCouponForOrder);
    }

    private AppliedCoupon calculateAppliedCoupon(Coupon coupon, List<CouponLineItem> items) {
        if (coupon.getStatus() == CouponStatus.USED) {
            throw new BusinessException(ErrorCode.COUPON_ALREADY_USED, "优惠券已被使用");
        }
        if (items == null || items.isEmpty()) {
            throw new BusinessException(ErrorCode.BAD_REQUEST, "订单中没有可用商品");
        }

        Set<UUID> eligibleProductIds = resolveEligibleProductIds(coupon,
                items.stream().map(CouponLineItem::productId).collect(Collectors.toSet()));
        BigDecimal eligibleSubtotal = items.stream()
                .filter(item -> eligibleProductIds.contains(item.productId()))
                .map(CouponLineItem::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        if (eligibleSubtotal.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.COUPON_NOT_APPLICABLE, "优惠券不适用于当前商品");
        }
        if (coupon.getMinOrderAmount() != null && coupon.getMinOrderAmount().compareTo(BigDecimal.ZERO) > 0
                && eligibleSubtotal.compareTo(coupon.getMinOrderAmount()) < 0) {
            throw new BusinessException(ErrorCode.COUPON_NOT_APPLICABLE,
                    "当前商品金额未达到优惠券门槛，至少需消费 " + coupon.getMinOrderAmount().setScale(2, RoundingMode.HALF_UP) + " 元");
        }

        BigDecimal discountAmount;
        switch (coupon.getType()) {
            case FIXED_AMOUNT:
                discountAmount = coupon.getDiscountValue().min(eligibleSubtotal);
                break;
            case PERCENTAGE:
                discountAmount = eligibleSubtotal.multiply(coupon.getDiscountValue())
                        .divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
                break;
            default:
                throw new BusinessException(ErrorCode.COUPON_INVALID, "无效的优惠类型");
        }

        if (discountAmount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠券折扣无效");
        }

        return new AppliedCoupon(coupon, discountAmount.setScale(2, RoundingMode.HALF_UP));
    }

    private Set<UUID> resolveEligibleProductIds(Coupon coupon, Set<UUID> orderProductIds) {
        if (coupon.isAppliesToAllProducts()) {
            return orderProductIds;
        }
        Set<UUID> allowedProductIds = couponProductRepository.findByCouponId(coupon.getId()).stream()
                .map(CouponProduct::getProductId)
                .collect(Collectors.toSet());
        Set<UUID> eligible = new LinkedHashSet<>(orderProductIds);
        eligible.retainAll(allowedProductIds);
        return eligible;
    }

    private Map<String, Object> toCouponMap(Coupon coupon, List<CouponProduct> relations, Map<UUID, Product> productMap) {
        List<UUID> productIds = relations.stream().map(CouponProduct::getProductId).toList();
        List<Map<String, Object>> products = productIds.stream()
                .map(productMap::get)
                .filter(Objects::nonNull)
                .map(product -> {
                    Map<String, Object> map = new LinkedHashMap<>();
                    map.put("id", product.getId());
                    map.put("title", product.getTitle());
                    return map;
                })
                .toList();

        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", coupon.getId());
        map.put("code", coupon.getCode());
        map.put("name", coupon.getName());
        map.put("type", coupon.getType().name());
        map.put("discount_value", coupon.getDiscountValue());
        map.put("min_order_amount", coupon.getMinOrderAmount());
        map.put("status", coupon.getStatus().name());
        map.put("applies_to_all_products", coupon.isAppliesToAllProducts());
        map.put("applicable_product_ids", productIds);
        map.put("applicable_products", products);
        map.put("used_order_id", coupon.getUsedOrderId());
        map.put("used_at", coupon.getUsedAt());
        map.put("created_at", coupon.getCreatedAt());
        map.put("updated_at", coupon.getUpdatedAt());
        return map;
    }

    private Map<UUID, List<CouponProduct>> loadCouponProducts(List<UUID> couponIds) {
        if (couponIds.isEmpty()) {
            return Map.of();
        }
        return couponProductRepository.findByCouponIdIn(couponIds).stream()
                .collect(Collectors.groupingBy(CouponProduct::getCouponId));
    }

    private Map<UUID, Product> loadProducts(Set<UUID> productIds) {
        if (productIds.isEmpty()) {
            return Map.of();
        }
        return productRepository.findAllById(productIds).stream()
                .filter(product -> product.getIsDeleted() == 0)
                .collect(Collectors.toMap(Product::getId, Function.identity()));
    }

    private CouponPayload parsePayload(Map<String, Object> request, UUID currentCouponId) {
        String code = normalizeCode((String) request.get("code"));
        String name = request.get("name") != null ? request.get("name").toString().trim() : "";
        CouponType type = parseType((String) request.get("type"));
        BigDecimal discountValue = parseDiscountValue(request.get("discount_value"), type);
        BigDecimal minOrderAmount = parseMinOrderAmount(request.get("min_order_amount"));
        boolean appliesToAllProducts = parseBoolean(request.get("applies_to_all_products"));
        List<UUID> productIds = parseProductIds(request.get("product_ids"));

        if (code == null || code.isBlank()) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠券编码不能为空");
        }
        if (name.isBlank()) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠券名称不能为空");
        }
        if (!appliesToAllProducts && productIds.isEmpty()) {
            throw new BusinessException(ErrorCode.COUPON_NOT_APPLICABLE, "请选择至少一个适用商品");
        }
        validateProductIds(productIds);

        return new CouponPayload(code, name, type, discountValue, minOrderAmount, appliesToAllProducts, productIds, currentCouponId);
    }

    private void applyPayload(Coupon coupon, CouponPayload payload) {
        coupon.setCode(payload.code());
        coupon.setName(payload.name());
        coupon.setType(payload.type());
        coupon.setDiscountValue(payload.discountValue());
        coupon.setMinOrderAmount(payload.minOrderAmount());
        coupon.setAppliesToAllProducts(payload.appliesToAllProducts());
    }

    private BigDecimal eligibleSubtotal(Coupon coupon, List<CouponLineItem> items) {
        Set<UUID> eligibleProductIds = resolveEligibleProductIds(coupon,
                items.stream().map(CouponLineItem::productId).collect(Collectors.toSet()));
        return items.stream()
                .filter(item -> eligibleProductIds.contains(item.productId()))
                .map(CouponLineItem::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);
    }

    private void replaceCouponProducts(Coupon coupon, List<UUID> productIds) {
        couponProductRepository.deleteByCouponId(coupon.getId());
        if (coupon.isAppliesToAllProducts()) {
            return;
        }
        for (UUID productId : productIds) {
            CouponProduct relation = new CouponProduct();
            relation.setCouponId(coupon.getId());
            relation.setProductId(productId);
            couponProductRepository.save(relation);
        }
    }

    private List<PreviewItem> parsePreviewItems(Object rawItems) {
        if (!(rawItems instanceof List)) {
            return List.of();
        }
        List<?> rawList = (List<?>) rawItems;
        List<PreviewItem> items = new ArrayList<>();
        for (Object rawItem : rawList) {
            if (!(rawItem instanceof Map)) {
                continue;
            }
            Map<?, ?> map = (Map<?, ?>) rawItem;
            Object productId = map.get("product_id");
            Object specId = map.get("spec_id");
            Object quantity = map.get("quantity");
            if (productId == null || quantity == null) {
                continue;
            }
            items.add(new PreviewItem(
                    UUID.fromString(productId.toString()),
                    specId != null && !specId.toString().isBlank() ? UUID.fromString(specId.toString()) : null,
                    Integer.parseInt(quantity.toString())
            ));
        }
        return items;
    }

    private List<CouponLineItem> buildLineItems(List<PreviewItem> items) {
        List<CouponLineItem> lineItems = new ArrayList<>();
        for (PreviewItem item : items) {
            if (item.quantity() <= 0) {
                throw new BusinessException(ErrorCode.BAD_REQUEST, "购买数量必须大于 0");
            }
            Product product = productRepository.findById(item.productId())
                    .filter(p -> p.getIsDeleted() == 0 && p.isEnabled())
                    .orElseThrow(() -> new BusinessException(ErrorCode.PRODUCT_NOT_FOUND, "商品不存在或已下架"));
            BigDecimal unitPrice = getUnitPrice(product, item.specId(), item.quantity());
            lineItems.add(new CouponLineItem(
                    item.productId(),
                    unitPrice.multiply(BigDecimal.valueOf(item.quantity())).setScale(2, RoundingMode.HALF_UP)
            ));
        }
        return lineItems;
    }

    private BigDecimal getUnitPrice(Product product, UUID specId, int quantity) {
        BigDecimal basePrice = product.getBasePrice();
        if (specId != null) {
            ProductSpec spec = productSpecRepository.findById(specId)
                    .filter(s -> s.getProductId().equals(product.getId()) && s.getIsDeleted() == 0)
                    .orElseThrow(() -> new BusinessException(ErrorCode.SPEC_NOT_FOUND, "商品规格不存在或与商品不匹配"));
            basePrice = spec.getPrice();
        }

        if (product.isWholesaleEnabled()) {
            List<WholesaleRule> rules = specId != null
                    ? wholesaleRuleRepository.findByProductIdAndSpecIdOrderByMinQuantityAsc(product.getId(), specId)
                    : wholesaleRuleRepository.findByProductIdAndSpecIdIsNullOrderByMinQuantityAsc(product.getId());
            for (int i = rules.size() - 1; i >= 0; i--) {
                if (quantity >= rules.get(i).getMinQuantity()) {
                    return rules.get(i).getUnitPrice();
                }
            }
        }
        return basePrice;
    }

    private void validateProductIds(List<UUID> productIds) {
        if (productIds.isEmpty()) {
            return;
        }
        Set<UUID> uniqueIds = new LinkedHashSet<>(productIds);
        long count = productRepository.findAllById(uniqueIds).stream()
                .filter(product -> product.getIsDeleted() == 0)
                .count();
        if (count != uniqueIds.size()) {
            throw new BusinessException(ErrorCode.PRODUCT_NOT_FOUND, "所选适用商品不存在或已下架");
        }
    }

    private CouponStatus parseStatus(String status) {
        if (status == null || status.isBlank()) {
            return null;
        }
        try {
            return CouponStatus.valueOf(status.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.BAD_REQUEST, "无效的优惠券状态");
        }
    }

    private CouponType parseType(String type) {
        if (type == null || type.isBlank()) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "请选择优惠类型");
        }
        try {
            return CouponType.valueOf(type.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "无效的优惠类型");
        }
    }

    private BigDecimal parseDiscountValue(Object rawValue, CouponType type) {
        if (rawValue == null) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠值不能为空");
        }
        BigDecimal discountValue;
        try {
            discountValue = new BigDecimal(rawValue.toString()).setScale(2, RoundingMode.HALF_UP);
        } catch (Exception e) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠值格式不正确");
        }
        if (discountValue.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "优惠值必须大于 0");
        }
        if (type == CouponType.PERCENTAGE && discountValue.compareTo(BigDecimal.valueOf(100)) > 0) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "百分比优惠不能超过 100");
        }
        return discountValue;
    }

    private BigDecimal parseMinOrderAmount(Object rawValue) {
        if (rawValue == null || rawValue.toString().isBlank()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal minOrderAmount;
        try {
            minOrderAmount = new BigDecimal(rawValue.toString()).setScale(2, RoundingMode.HALF_UP);
        } catch (Exception e) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "最低消费门槛格式不正确");
        }
        if (minOrderAmount.compareTo(BigDecimal.ZERO) < 0) {
            throw new BusinessException(ErrorCode.COUPON_INVALID, "最低消费门槛不能小于 0");
        }
        return minOrderAmount;
    }

    private List<UUID> parseProductIds(Object rawProductIds) {
        if (!(rawProductIds instanceof List)) {
            return List.of();
        }
        List<?> rawList = (List<?>) rawProductIds;
        List<UUID> productIds = new ArrayList<>();
        for (Object raw : rawList) {
            if (raw == null || raw.toString().isBlank()) {
                continue;
            }
            productIds.add(UUID.fromString(raw.toString()));
        }
        return productIds.stream().distinct().toList();
    }

    private boolean parseBoolean(Object value) {
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value == null) {
            return false;
        }
        String text = value.toString().trim();
        return "true".equalsIgnoreCase(text) || "1".equals(text) || "yes".equalsIgnoreCase(text);
    }

    private String normalizeCode(String code) {
        if (code == null) {
            return null;
        }
        return code.trim().replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    private String normalizeKeyword(String keyword) {
        if (keyword == null || keyword.isBlank()) {
            return null;
        }
        return "%" + keyword.trim().toLowerCase(Locale.ROOT) + "%";
    }

    private BigDecimal calculateActualAmount(BigDecimal totalAmount, BigDecimal pointsDiscount) {
        BigDecimal total = totalAmount != null ? totalAmount : BigDecimal.ZERO;
        BigDecimal points = pointsDiscount != null ? pointsDiscount : BigDecimal.ZERO;
        return total.subtract(points).max(BigDecimal.ZERO).setScale(2, RoundingMode.HALF_UP);
    }

    private record CouponPayload(
            String code,
            String name,
            CouponType type,
            BigDecimal discountValue,
            BigDecimal minOrderAmount,
            boolean appliesToAllProducts,
            List<UUID> productIds,
            UUID currentCouponId
    ) {}
}
