package com.orionkey.repository;

import com.orionkey.constant.CouponStatus;
import com.orionkey.entity.Coupon;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CouponRepository extends JpaRepository<Coupon, UUID> {

    @Query("SELECT c FROM Coupon c WHERE c.isDeleted = 0 " +
            "AND (:status IS NULL OR c.status = :status) " +
            "AND (:keywordPattern IS NULL OR LOWER(c.code) LIKE :keywordPattern OR LOWER(c.name) LIKE :keywordPattern) " +
            "ORDER BY c.createdAt DESC")
    Page<Coupon> searchAdminCoupons(@Param("status") CouponStatus status,
                                    @Param("keywordPattern") String keywordPattern,
                                    Pageable pageable);

    @Query("SELECT c FROM Coupon c WHERE c.id = :id AND c.isDeleted = 0")
    Optional<Coupon> findActiveById(@Param("id") UUID id);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT c FROM Coupon c WHERE LOWER(c.code) = LOWER(:code) AND c.isDeleted = 0")
    Optional<Coupon> findActiveByCodeForUpdate(@Param("code") String code);

    @Query("SELECT c FROM Coupon c WHERE LOWER(c.code) = LOWER(:code) AND c.isDeleted = 0")
    Optional<Coupon> findActiveByCode(@Param("code") String code);

    @Query("SELECT CASE WHEN COUNT(c) > 0 THEN true ELSE false END FROM Coupon c " +
            "WHERE LOWER(c.code) = LOWER(:code) AND c.isDeleted = 0 AND (:excludeId IS NULL OR c.id <> :excludeId)")
    boolean existsActiveCode(@Param("code") String code, @Param("excludeId") UUID excludeId);

    Optional<Coupon> findByUsedOrderId(UUID usedOrderId);

    List<Coupon> findByUsedOrderIdIn(Collection<UUID> usedOrderIds);
}
