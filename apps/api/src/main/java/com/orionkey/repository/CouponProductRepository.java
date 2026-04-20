package com.orionkey.repository;

import com.orionkey.entity.CouponProduct;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface CouponProductRepository extends JpaRepository<CouponProduct, UUID> {

    List<CouponProduct> findByCouponId(UUID couponId);

    List<CouponProduct> findByCouponIdIn(Collection<UUID> couponIds);

    void deleteByCouponId(UUID couponId);
}
